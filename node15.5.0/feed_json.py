import json
import sys
import requests
import datetime

source = "../security-event-score-py/bq-results-20201226-231908-e4ur6cyoqgkc.json"
#source = "../security-event-score-py/bq-results-head.json"
lines = []

with open(source) as f:
    count = 0
    for x in f:
        lines.append(json.loads(x))


def main(repeat, lines):
    if repeat == 0:
        repeat = len(lines)
    for i in range(min(repeat, len(lines))):
        d = lines[i]["published"]
        try:
            date = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S.%f UTC").isoformat()
        except:
            date = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S UTC").isoformat()

        if True:
            context = "okta_by_ip"
            requires = ["ipAddress", "eventType", "result"]
            if len([x for x in requires if x in lines[i].keys()]) == len(requires):
                key = lines[i]["ipAddress"]
                action = "{}:{}".format(lines[i]["eventType"], lines[i]["result"])
                params = {
                        "context": context,
                        "key": key,
                        "action": action,
                        "date": date
                        }
                r = requests.get('http://localhost:5000/ratemykey', params=params)
                print(r.text)
    
        if False:
            context = "okta_by_user"
            requires = ["alternateid", "eventType", "result"]
            if len([x for x in requires if x in lines[i].keys()]) == len(requires):
                key = lines[i]["alternateid"]
                action = "{}:{}".format(lines[i]["eventType"], lines[i]["result"])
    
                params = {
                        "context": context,
                        "key": key,
                        "action": action,
                        "date": date
                        }
                r = requests.get('http://localhost:5000/ratemykey', params=params)
                print(r.text)

repeat = 1
if len(sys.argv) == 2:
    repeat = int(sys.argv[1])

main(repeat, lines)
