import json
import sys
import requests
import datetime
from math import log, ceil

context = sys.argv[1] or "test"
datefield = sys.argv[2] or "created"
keyfield = sys.argv[3] or "buyer_id"
actionfield = sys.argv[4] or "paid_method"
valuefield = sys.argv[5] or "price"

def ceil_power_of_10(n):
    exp = log(n, 10)
    exp = ceil(exp)
    return 10**exp

if context and datefield and keyfield and actionfield:
    for raw in sys.stdin:
        line = json.loads(raw)
        d = line[datefield]
        try:
            date = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S.%f UTC").isoformat()
        except:
            date = datetime.datetime.strptime(d, "%Y-%m-%d %H:%M:%S UTC").isoformat()
            key = line[keyfield]
            action = line[actionfield]
            value = ceil_power_of_10(int(line[valuefield]))
            params = {
                    "context": context,
                    "key": key,
                    "action": "{}:{}".format(action, value),
                    "date": date
                    }
            r = requests.get('http://localhost:5000/ratemykey', params=params)
            print(r.text)
else:
    print("context:", context, "date field:", datefield, "key field:", keyfield, "action field:", actionfield)