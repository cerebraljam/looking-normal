# Does it look normal?

Security standards are keen in asking logs to be monitored. It is also expected that whoever or whatever will monitor these logs will detect anomalies.

... Unless the person/code monitoring the logs knows the likelihood of each event happening, everything will be hard to explain.

This is what this code is trying to achieve.

# How to run the service
`docker-compose up`

# How to use

A client submit 3 information to this service
* context: for example, query_by_ip
* key: unique key identifying the actor doing the action. for example, the ip address
* action: what the actor did. for example: `login:success`. this string can be whatever, as long as it represent a discrete action
* (option) date in iso format. if it is undefined, it will use the current server date. This is useful when events needs to be replayed, or if they are delayed.

Usage example:
```
curl http://service:5000/ratemykey?context=authentication&key=1.2.3.4&action=/login:success
```
The service will return something like this
```
{"context": "authentication", "key": "1.2.3.4", "action": "/login:success", "runtime": 0.12289857864379883, "result": {"keys": "1.2.3.4", "surprisals": 22668.486066189835, "counts": 4524, "sz": 17.485557229264874, "normalizeds": 5.010717521262121, "nz": 1.1418003271427444, "outlier": "false"}}
```
The outlier value will be "true" only if sz (surprisal zscore) and nz (normalized zscore) are both 3 or more standard deviation from the average.

when a new action is submitted for a key, the entry in the database is updated. Any key inactive for more than a day will be flushed.



