import time
import datetime
import os.path
import math
import numpy as np
import json

from flask import Flask, request, send_from_directory

from pymongo import MongoClient
mclient = MongoClient('mongodb://mongo:27017')
mdb = mclient['eventscore']

app = Flask(__name__)

def insert(context, key, action, now):
    #print("* insert")

    collection = mdb[context]
    #now = datetime.datetime.utcnow()

    if "key" not in collection.index_information():
        collection.create_index("key")

    r = collection.find_one({"key": key})

    if r:
        #print("* existing:", r)
        id = collection.update_one(
                { "_id": r["_id"] }, # query filter
                { "$push" : { "actions": action }, "$set": { "date": now } }, # document
                upsert=True
                )
    else:
        id = collection.insert_one(
                { "key": key, "actions": [action], "date": now } # replacement document
                )

    return id

def aggregate_actions(context):
    #print("* aggregate_actions")
    collection = mdb[context]
    return collection.aggregate([
        { "$unwind": "$actions" },
        {
            "$group": {
                "_id": "$actions",
                "count": { "$sum": 1 }
                }
            }
        ])

def score_keys(context, acs, now):
    #print("* score_keys")
    collection = mdb[context]

    feature = "normalized"

    #now = datetime.datetime.utcnow()
    time_limit = now - datetime.timedelta(days=1)

    if "date" not in collection.index_information():
        collection.create_index("date")

    d = collection.delete_many({"date": {"$lt": time_limit}})
    #r = collection.find({"date": { "$gt": time_limit}})
    r = collection.find({})

    score = { "keys": [], "surprisals": [], "counts": [], "sz": [], "normalizeds": [], "nz": [] }
    for row in r:
        key = row['key']
        surp = sum([acs[a]['surprisal'] for a in row['actions']])
        score['keys'].append(key)
        score['surprisals'].append(surp)
        score['sz'].append(0)
        score['nz'].append(0)
        score['counts'].append(len(row['actions']))
        # this is an attempt to handle long running sessions that will trigger an alert
        # over time because of all the actions done
        score['normalizeds'].append(surp/len(row['actions']))

    saverage = np.mean(score["surprisals"])
    sstd = np.std(score["surprisals"])
    naverage = np.mean(score["normalizeds"])
    nstd = np.std(score["normalizeds"])

    for i in range(len(score['keys'])):
        if sstd != 0:
            sz = (score["surprisals"][i] - saverage) / sstd
        else:
            sz = 0
        score['sz'][i] = sz if sz else 0

        if nstd != 0:
            nz = (score["normalizeds"][i] - naverage) / nstd
        else:
            nz = 0
        score['nz'][i] = nz if nz else 0

        #if z >= 3:
        #    pivoted = {key: score[key][i] for key in list(score.keys())}
        #    print("* Outlier found:", pivoted)

    return score

def add_surprisal(context, data):
    #print("* adding surprisal")
    total = 0
    action_score = {}
    for d in data:
        action_score[d['_id']] = {'count': d['count']}
        total += d['count']

    for k in action_score.keys():
        n = action_score[k]["count"]
        action_score[k]['surprisal'] = np.log2(1/(n/total))

    return action_score

def rate_key(score, key):
    #print("* rate_key")
    idx = score['keys'].index(key)
    result = {key: score[key][idx] for key in list(score.keys())}
    result['outlier'] = "true" if score['sz'][idx] >= 3 and score['nz'][idx] >= 3 else "false"

    return result

@app.route('/')
def root():
    return 'Hello World!\n'

@app.route('/ratemykey')
def event():
    start = time.time()
    context = request.args.get('context', default='trash', type=str)
    key = request.args.get('key', default='trash', type=str)
    action = request.args.get('action', default='trash', type=str)
    date = datetime.datetime.fromisoformat(request.args.get('date', default=datetime.datetime.utcnow().isoformat(), type=str))

    if "trash" in [context, key, action]:
        return "fail"

    id = insert(context, key, action, date)
    aggregated = aggregate_actions(context)
    action_score = add_surprisal(context, aggregated)
    score = score_keys(context, action_score, date)

    return json.dumps({"context": context, "key": key, "action": action, "runtime": time.time() - start, "result": rate_key(score, key)})

