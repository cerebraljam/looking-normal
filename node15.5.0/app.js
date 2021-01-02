'use strict'

const inspect = require('util').inspect
const assert = require('assert')
const MongoClient = require('mongodb').MongoClient
const math = require('mathjs')

const express = require('express')
const bodyParser = require('body-parser')

// Constants

const PORT = process.env.PORT || 5000
const HOST = process.env.HOST || "0.0.0.0"
const MONGOURL = "mongodb://mongo:27017/"
const DBNAME = "ratemykey"

var db = false

MongoClient.connect(MONGOURL, function(err, client) {
	assert.equal(null, err)
	//console.log("Connected successfully to database")

	db = client.db(DBNAME)
})

const insert = function(db, key, action, now, next) {
	db.insertOne({"key": key, "actions": [], "date": now}, function(err, result) {
		assert.equal(err, null)
		assert.equal(1, result.result.n)
		assert.equal(1, result.ops.length)

		//console.log("step 1: inserted " + key + " " + action)
		next(result.result.n)
	})
}

const update = function(db, key, action, now, next) {
	db.updateOne({"key": key}, { $push: { "actions": action } }, function(err, result) {
		assert.equal(err, null)
		if (result.result.n == 0) {
			insert(db, key, action, now, next)
		} else {
			//console.log("step 1: Updated one document")
			next(result.result.n)
		}
	})
}

const aggregateActions = function(db, next) {
	db.aggregate([
    	{ "$unwind": "$actions" },
        {
            "$group": {
                "_id": "$actions",
                "count": { "$sum": 1 }
                }
            }
        ], function(err, cursor) {
			assert.equal(err, null)
			cursor.toArray(function(err, documents) {
				//console.log("step 2: aggregation")
				//console.log(documents)
				next(documents)
			})
		})
}

const addSurprisal = async function(db, data) {
	//console.log("step 3: add_surprisal")
	let total = 0
	let actionScore = {}

	// initializing and counting the number of actions total
	for (let d in data) {
		let action = data[d]['_id']
		total += data[d]['count']
	}

	for (let d in data) {
		let action = data[d]['_id']
		let n = data[d]['count']

		actionScore[action] = {
			'count': data[d]['count'],
			'surprisal': Math.log2(1/(n/total))
		}
	}
	
	return actionScore
}

const scoreKeys = async function(db, actionScore, date, next) {
	//console.log("step 4: score keys")

    let timeLimit = new Date(date.getTime() - 86400000)

	//console.log("actionScore: " + inspect(actionScore))

	db.find({"date": {"$gt": timeLimit}}).toArray(function(err, docs) {
		assert.equal(err, null)

		let score = {
			"keys": [], 
			"surprisals": [], 
			"normalizeds": [], 
			"counts": [], 
			"sz": [], 
			"nz": [], 
			"outlier": false
		}

		for (let row in docs) {
			//console.log('row: ' + docs[row])
			
			let key = docs[row]['key']
			let surp = docs[row]['actions'].reduce(function(accumulator, currentValue) {
				return accumulator + actionScore[currentValue]['surprisal']
			},0)
			
			score['keys'].push(key)
			score['surprisals'].push(surp)
			score['sz'].push(0)
			score['nz'].push(0)
			score['counts'].push(docs[row]['actions'].length || 0)
			score['normalizeds'].push(surp/docs[row]['actions'].length || 0)
		}

		//let n = score['surprisals'].length
		//let sSum = score['surprisals'].reduce((accumulator, current) => accumulator + current, 0)
		let sAverage = math.mean(score['surprisals']) || 0
		let sStd = math.std(score['surprisals'], 'uncorrected')

		//console.log('* N:', score['normalizeds'])
		//let nSum = score['normalizeds'].reduce((accumulator, current) => accumulator + current, 1)
		//let nAverage = nSum / n || 0
		let nAverage = math.mean(score['normalizeds']) || 0
		let nStd = math.std(score['normalizeds'], 'uncorrected')
		//console.log('* n', nSum, nAverage, nStd, n)

		// calculate the surprisal zscore and normalized zscore for each "key"

		for (let i = 0; i < score['keys'].length; i++) {
			score['sz'][i] = (score["surprisals"][i] - sAverage) / sStd || 0
			score['nz'][i] = (score["normalizeds"][i] - nAverage) / nStd || 0
		}
		
		next(score)
	})


	db.deleteMany({"date": {"$lt": timeLimit}}, function(err, result) {
		assert.equal(err, null)
	})
}

const rateKey = async function(score, key) {
	//console.log("step 5: rate_key")

	let idx = score['keys'].indexOf(key)

	let result = {}

	for (let x in score) {
		result[x] = score[x][idx]
	}

	if (result['sz'] >= 3 && result['nz'] >= 3) {
		result['outlier'] = true
	} else {
		result['outlier'] = false
	}
	//console.log('rateKey pivot:' + inspect(result))

	return result
}

const flushContext = async function(context, next) {
	const collection = db.collection(context)
	
	await collection.deleteMany({}, function(err, result) {
		if (err) {
			console.error(err)
			next(false)
		} 
		//console.log('result' + result)
		next(true)
	})
}

const indexCollection = async function(collection, key) {
	//console.log("checking index for " + key)
	await collection.createIndex({key: 1}, null, function(err, results) {
		//console.log(results)
	})
}

// App
const app = express()
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

app.get('/', (req, res) => {
	res.send('Nothing to see here...')
})

app.get('/reset', function(req, res) {
	const context = req.query.context || "trash"
	if (db != false && context != "trash") {
		let result = flushContext(context, function(result) {
			if (result) {
				res.send("Removed all documents from " + context)
			} else {
				res.send('could not remove document from ' + context)
			}
		})

	} else {
		res.send('context parameter not defined')
	}
})

app.get('/ratemykey', async function(req, res) {
	const startDate = new Date()

	const context = req.query.context || "trash"
	const key = req.query.key || "trash"
	const action = req.query.action || "trash"
	const date = req.query.date || new Date().toISOString()
    var array = [context, key, action]

	if (db != false && array.indexOf("trash") == -1) {

		const collection = db.collection(context)

		// step 1
		await indexCollection(collection, "key")
		update(collection, key, action, new Date(date), function(n) {
			if (n) {
				// step 2
				aggregateActions(collection, async function(aggregated) {
					// step 3
					let actionScore = await addSurprisal(collection, aggregated)

					// step 4
					await indexCollection(collection, "date")

					scoreKeys(collection, actionScore, new Date(date), async function(score) {
						// step 5
						let rate = await rateKey(score, key)
	
						const runtime = (new Date() - startDate) / 1000
						//console.log('sending response')
						res.json({"context": context, "key": key, "action": action, "date": date, "runtime": runtime, "result": rate})
					})
				})
			} else {
				console.error("document was not inserted or updated")
				res.json({"error": true})
			}
		})
	} else {
		res.send('Hello World')
    }
})

const server = app.listen(PORT, HOST, function() {
	console.log(`Running on http://${HOST}:${PORT}`)
})
