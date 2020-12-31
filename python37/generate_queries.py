import random
import sys
import requests

random.seed(42)

def main(repeat):
    context = "auth"
    actions = ["login", "get", "get", "update", "update", "download", "download", "download", "upload", "update", "edit", "logout"]

    for i in range(repeat):
        params = {
                "context": context,
                "key": "user{}".format(random.randint(10,1000)),
                "action": random.choice(actions)
                }
        r = requests.get('http://localhost:8080/ratemykey', params=params)
        print(r.text)


repeat = 1
if len(sys.argv) == 2:
    repeat = int(sys.argv[1])
    print("repeating {} times".format(repeat))

main(repeat)

