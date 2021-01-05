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
const SZLIMIT = Number(process.env.SZLIMIT) || 3
const NZLIMIT = Number(process.env.NZLIMIT) || 3

var db = false
var didCheckIndexes = false

// Design decision: Why did I use Mongodb and not sql?
// A. both would have work. I used to use Bigquery to do the same thing. Mongodb
//    allowed me to keep a document per key, which seemed more memory efficient
//    if we had to handle with a lot of actors, and seemed to be easier to port
//    in a full memory based database (ex.: redis) if mongodb can't handle the load

// Initialization of the connection to the database
MongoClient.connect(MONGOURL, function(err, client) {
	assert.equal(null, err)
	//console.log("Connected successfully to database")
	db = client.db(DBNAME)
})

// Design decision: why am I using an array of actions instead of counting 
// listing only unique actions and keeping a counter in parallel?
// A. Some sessions can go forever. Actions taken few days ago can be
//    irrelevant to calculate how current actions are important. Keeping an 
//    array of all actions and cuting after 1000 allows the app to forget
//    past actions, which is not possible to flush counts from a previous day,
//    unless we keep distint counters per day.

// Function: insert
// Called by: update 
// Used for: if the update function did not find the key specified, `insert` will create a
//           new entry in the database
// receives:
//    collection: a collection object previously initialized
//    key: unique actor identifier (ex.: ip, host, username)
//    action: a string representing any discrete action being done (ex.: /login, /login:failure)
//    now: date and time of the event, provided by the client or current system date time
//    next: callback function
// Return: Nothing. Result transmitted through callback
const insert = function(collection, key, action, now, next) {
	collection.insertOne({"key": key, "actions": [], "date": now}, function(err, result) {
		assert.equal(err, null)
		assert.equal(1, result.result.n)
		assert.equal(1, result.ops.length)

		//console.log("step 1: inserted " + key + " " + action)
		next(result.result.n)
	})
}

// Function: update
// Called by: /ratemykey web endpoint as step 1
// Used For: add new actions to the document related to "key"
// Receives:
//    collection: a collection object previously initialized
//    key: unique actor identifier (ex.: ip, host, username)
//    action: a string representing any discrete action being done (ex.: /login, /login:failure)
//    now: date and time of the event, provided by the client or current system date time
//    next: callback function
// Return: Nothing. Result transmitted through callback
const update = function(collection, key, action, now, next) {
	collection.updateOne({"key": key}, { $push: { "actions": { $each: [action], $slice: -1000 } }}, function(err, result) {
		assert.equal(err, null)
		if (result.result.n == 0) {
			insert(collection, key, action, now, next)
		} else {
			//console.log("step 1: Updated one document")
			next(result.result.n)
		}
	})
}

// Function: aggregateActions
// Called by: /ratemykey web endpoint as step 2
// Used For: count the frequency of each actions in every "key" documents
// Receives:
//    collection: a collection object previously initialized
//    next: callback function
// Return: Nothing. Result transmitted through callback
const aggregateActions = function(collection, next) {
	collection.aggregate([
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
				next(documents)
			})
		})
}

// Function: addSurprisal
// Called by: /ratemykey web endpoint as step 3
// Used For: calculate and return a lookup table that will be used to
//           give an information value (in bits) to each actions given their likelihood
// Receives:
//   data: frequency of each actions calculated by the aggregateAtions function
// Return:
//   a lookup table containing the count and cross entropy value for each action
const addSurprisal = async function(data) {
	//console.log("step 3: addXEntropy")
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
			'xentropy': Math.log2(1/(n/total))
		}
	}
	
	return actionScore
}

// Function: scoreKeys
// Called by: /ratemykey web endpoint as step 4
// Used For: Goes through each "key" in the database, lookup the information value
//           of each action done by the user, sum up the amount of information
//           Will calculate the cross entropy, normalized count, xz, nz values for each key
// Receives:
//    collection: a collection object previously initialized
//    actionScore: lookup table created by the addSurprisal function
//    date: date and time of the event, provided by the client or current system date time
//    next: callback function
// Return: Nothing. Result transmitted through callback
const scoreKeys = async function(collection, actionScore, date, next) {
	//console.log("step 4: score keys")

    let timeLimit = new Date(date.getTime() - 86400000)

	collection.find({"date": {"$gt": timeLimit}}).toArray(function(err, docs) {
		assert.equal(err, null)

		let score = {
			"keys": [], 
			"xentropy": [], 
			"normalizeds": [], 
			"counts": [], 
			"xz": [], 
			"nz": [], 
			"outlier": false
		}

		for (let row in docs) {
			let key = docs[row]['key']
			let surp = docs[row]['actions'].reduce(function(accumulator, currentValue) {
				return accumulator + actionScore[currentValue]['xentropy']
			},0)
			
			score['keys'].push(key)
			score['xentropy'].push(surp)
			score['xz'].push(0)
			score['nz'].push(0)
			score['counts'].push(docs[row]['actions'].length || 0)
			score['normalizeds'].push(surp/docs[row]['actions'].length || 0)
		}

		let sAverage = math.mean(score['xentropy']) || 0
		let sStd = math.std(score['xentropy'], 'uncorrected')

		let nAverage = math.mean(score['normalizeds']) || 0
		let nStd = math.std(score['normalizeds'], 'uncorrected')

		// calculate the cross entropy zscore and normalized zscore for each "key"
		for (let i = 0; i < score['keys'].length; i++) {
			score['xz'][i] = (score["xentropy"][i] - sAverage) / sStd || 0
			score['nz'][i] = (score["normalizeds"][i] - nAverage) / nStd || 0
		}
		
		next(score)
	})

    // after everything is completed and the answer is returned to the client
    // we cleanup old entries in the database
	collection.deleteMany({"date": {"$lt": timeLimit}}, function(err, result) {
		assert.equal(err, null)
	})
}

// Function: rateKey
// Called by: /ratemykey web endpoint as step 5
// Used for: Will extract the data from score memory object (created by scoreKeys)
//           and pivot the result to return an object
//           Will set the outlier to true or false depending of the SZLIMIT and NZLIMIT
//           cnfigured in the Dockerfile
// Receive:
//   score: list of all the scores for all the keys produced by the scoreKeys function
//   key: actor that we care about.
// Return: object containing all the relevant results for actor "key"
const rateKey = async function(score, key) {
	//console.log("step 5: rate_key")

	let idx = score['keys'].indexOf(key)

	let result = {}

	for (let x in score) {
		result[x] = score[x][idx]
	}

	if (result['xz'] >= SZLIMIT && result['nz'] >= NZLIMIT) {
		result['outlier'] = true
	} else {
		result['outlier'] = false
	}

	return result
}


// Function: flushContext
// Called by: /reset web endpoint
// Used for: flush all information for a certain context. useful during testing, should not
//           be useful in production.
//           Note: should not be left accessible on the internet
// Receive:
//   context: "context" value for which we want to flush all the documents
// Return: Nothing. Success/Failure transmitted to the caller through the callback
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

// Function: indexcollection
// Called by: /ratebykey web endpoint at it's beginning
// Used for: when the application is started, we don't know if the collection already exists
//           in the database. However, it is only called if didCheckIndexes is false, normally
//           at the first call of the /ratemykey endpoint
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

// Default endpoint, returns nothing interesting
app.get('/', (req, res) => {
	res.send('Nothing to see here...')
})

// Used to reset all data for a specified context
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

// Main endpoint for this app. coordinate everything
app.get('/ratemykey', async function(req, res) {
	const startDate = new Date()

	const context = req.query.context || "trash"
	const key = req.query.key || "trash"
	const action = req.query.action || "trash"
	const date = req.query.date || new Date().toISOString()
    var array = [context, key, action]

	if (db != false && array.indexOf("trash") == -1) {

		const collection = db.collection(context)

		if (!didCheckIndexes) {
			didCheckIndexes = true
			await indexCollection(collection, "key")
			await indexCollection(collection, "date")
		}

		// step 1
		update(collection, key, action, new Date(date), function(n) {
			if (n) {
				// step 2
				aggregateActions(collection, async function(aggregated) {
					// step 3
					let actionScore = await addSurprisal(aggregated)

					// step 4
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
