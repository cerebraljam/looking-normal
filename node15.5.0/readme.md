cat bq_test.txt |grep -v "SKIP"|cut -d' ' -f 5-|grep -e '^{'| jq '.|select((.result.xz >= 3) and (.result.nz >= 3) )'
