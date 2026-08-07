#!/bin/zsh
# $1 = label, $2 = python mutation on the copied source, $3 = which test file
set -e
D=/Users/m.ryabushkin/Projects/alamo-ui/.review-tmp
R=/Users/m.ryabushkin/Projects/alamo-ui/packages/server
rm -f $D/m-store.ts $D/m-svc.ts $D/m-svc.test.ts $D/m-store.test.ts
# copy sources with rewritten relative imports
sed -e "s#from './db.ts'#from '$R/src/store/db.ts'#" $R/src/store/capability-override.ts > $D/m-store.ts
sed -e "s#from './service.ts'#from '$R/src/models/service.ts'#" \
    -e "s#from '../runtime/observation-key.ts'#from '$R/src/runtime/observation-key.ts'#" \
    -e "s#from '../store/capability-override.ts'#from './m-store.ts'#" \
    $R/src/models/capability-override.ts > $D/m-svc.ts
sed -e "s#from '../src/models/capability-override.ts'#from './m-svc.ts'#" \
    -e "s#from '../src/store/capability-override.ts'#from './m-store.ts'#" \
    -e "s#from '../src/#from '$R/src/#g" \
    $R/test/capability-override-service.test.ts > $D/m-svc.test.ts
sed -e "s#from '../src/store/capability-override.ts'#from './m-store.ts'#" \
    -e "s#from '../src/#from '$R/src/#g" \
    $R/test/capability-override-store.test.ts > $D/m-store.test.ts
python3 -c "$2"
node --test $D/$3 2>&1 | grep -E "^(ℹ (tests|pass|fail))" | tr '\n' ' '
echo "   <== $1"
