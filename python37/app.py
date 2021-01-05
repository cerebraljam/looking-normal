import time
import datetime
import numpy as np
import json
import os

from flask import Flask, request

from pymongo import MongoClient

# the host name is defined in the docker-compose.yaml file
mclient = MongoClient('mongodb://mongo:27017')
mdb = mclient['ratemykey']

app = Flask(__name__)

# keep track of created indexes
did_check_indexes = False

SZLIMIT = int(os.getenv("SZLIMIT", default="3"))
NZLIMIT = int(os.getenv("NZLIMIT", default="2"))

def insert(context, key, action, now):
    collection = mdb[context]
    global did_check_indexes

    # check if the index for the "key" field exists already
    if not did_check_indexes:
        if "key" not in collection.index_information():
            collection.create_index("key")
        if "date" not in collection.index_information():
            collection.create_index("date")
        did_check_indexes = True

    r = collection.find_one({"key": key})

    # is this "key" found in the collection?
    if r:
        # if we did find one entry for the "key" already, then we update it
        id = collection.update_one(
                { "_id": r["_id"] }, # query filter
                { "$push" : { "actions": { "$each": [action], "$slice": -1000 } }, "$set": { "date": now } } # replacement document
                )
    else:
        # create a new one
        id = collection.insert_one(
                { "key": key, "actions": [action], "date": now } # document
                )

    return id

def aggregate_actions(context):
    collection = mdb[context]

    # query the collection in mongodb, unwind the "actions" array for each "key"
    # and count the number of time each action is observed
    return collection.aggregate([
        { "$unwind": "$actions" },
        {
            "$group": {
                "_id": "$actions",
                "count": { "$sum": 1 }
                }
            }
        ])

def add_xentropy(context, data):
    total = 0
    action_score = {}
    # step 1: we need to calculate the total amount of actions
    # "data" is a pointer on the mongodb response.
    for d in data:
        action_score[d['_id']] = {'count': d['count']}
        total += d['count']

    # step 2: once we have the total amount of actions, 
    # we can can calculate the cross entropy value of each action
    for k in action_score.keys():
        n = action_score[k]["count"]
        action_score[k]['xentropy'] = np.log2(1/(n/total))

    return action_score

def score_keys(context, acs, now):
    collection = mdb[context]

    time_limit = now - datetime.timedelta(days=1)

    # cleanup: delete old data from the database
    d = collection.delete_many({"date": {"$lt": time_limit}})

    # we select all the "key" in the current context
    r = collection.find({})

    # template the return value
    score = { "key": [], "xentropy": [], "count": [], "xz": [], "normalized": [], "nz": [] }

    # for each key, we calculate the different values
    for row in r:
        key = row['key'] 
        surp = sum([acs[a]['xentropy'] for a in row['actions']]) # sum of the cross entropy value for each action
        score['key'].append(key)
        score['xentropy'].append(surp) # cross entropy value calculated for the current "key"
        score['xz'].append(0) # cross entropy zscore will be calculated later. setting value to 0 for now
        score['nz'].append(0) # normalized zscore will be calculated later. setting value to 0 for now
        score['count'].append(len(row['actions'])) # number of actions for that key

        # this is an attempt to handle long running sessions that will trigger an alert
        # over time because of all the actions done. the cross entropy value of 500 actions
        # is likely to be higher than someone with 10 actions, but if we normalize by 
        # the number of actions then we can see the average value of each action
        score['normalized'].append(surp/len(row['actions']))

    # for cross entropy total, calculate the average and standard deviation for all "key"
    saverage = np.mean(score["xentropy"])
    sstd = np.std(score["xentropy"])

    # for normalized values, calculate the average and standard deviation for all "key"
    naverage = np.mean(score["normalized"])
    nstd = np.std(score["normalized"])

    # caculate the cross entropy zscore and normalized zscore for each "key"
    for i in range(len(score['key'])):
        if sstd != 0:
            xz = (score["xentropy"][i] - saverage) / sstd
        else:
            xz = 0
        score['xz'][i] = xz if xz else 0

        if nstd != 0:
            nz = (score["normalized"][i] - naverage) / nstd
        else:
            nz = 0
        score['nz'][i] = nz if nz else 0

    # Q. why I am not just updating cross entropy and zscore for the new "key"? 
    # A. the value of actions depends on the number of time it is used globally, therefore, 
    # if it changes because one key used it, then the cross entropy value will change for all 
    # "key" who also used it. so we have to rebalance the whole state every time

    # Q. why am I not only updating the state based on one change at the time?
    # A. this would still require to go through each "key", remove the previous cross entropy value
    # value for each time that user used the same key, then update the cross entropy with the
    # new value. and we still need to calculate the standard deviation, average and zscore 
    # for each "key" so we can compare them to each others after. I see little efficiency
    # gain.

    # return the scores for all "key"
    return score

def rate_key(score, key):
    idx = score['key'].index(key)

    # this is a pivot. score are stored as array. we transform the data in a dictionary
    result = {key: score[key][idx] for key in list(score.keys())}

    # this is not necessary if we are OPA to analyze rating
    # but at the command line, when doing grep on "true" makes it easier to filter
    result['outlier'] = "true" if score['xz'][idx] >= SZLIMIT and score['nz'][idx] >= NZLIMIT else "false"

    return result

@app.route('/')
def root():
    return 'Nothing to see here...\n'

@app.route('/reset')
def reset():
    context = request.args.get('context', default='trash', type=str)

    if context != 'trash':
        collection = mdb[context]
        collection.delete_many({})
        return 'Removed all documents from {}\n'.format(context)

    return 'context parameter not defined...\n'


# usage example curl https://host:5000/ratemykey?context=auth&key=1.2.3.4&action=login
@app.route('/ratemykey')
def event():
    start = time.time() # used to calculate the runtime

    # get the GET parameters 
    context = request.args.get('context', default='trash', type=str)
    key = request.args.get('key', default='trash', type=str)
    action = request.args.get('action', default='trash', type=str)
    # this is optional. will default to now if not provided
    date = datetime.datetime.fromisoformat(request.args.get('date', default=datetime.datetime.utcnow().isoformat(), type=str))

    # stop if any of the necessary parameters is "trash"
    if "trash" in [context, key, action]:
        return "fail"

    # Step 1: Insert the new information in the database
    id = insert(context, key, action, date)
    # Step 2: Aggregate the data and return the count of occurence for each action
    aggregated = aggregate_actions(context)
    # Step 3: use the aggregated data to calculate the information value of each action (in bits)
    action_score = add_xentropy(context, aggregated)
    # Step 4: go through each user, and calculate how much bits of information their actions generated
    score = score_keys(context, action_score, date)
    # Step 5: last step, we recover the value for the "key" submitted by the client
    rate = rate_key(score, key)

    return json.dumps({"context": context, "key": key, "action": action, "date": date.isoformat(), "runtime": time.time() - start, "result": rate})

