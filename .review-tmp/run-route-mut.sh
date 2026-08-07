#!/bin/zsh
set -e
D=/Users/m.ryabushkin/Projects/alamo-ui/.review-tmp
R=/Users/m.ryabushkin/Projects/alamo-ui/packages/server
rm -f $D/m-routes.ts $D/m-routes.test.ts
sed -e "s#from '../context.ts'#from '$R/src/context.ts'#" \
    -e "s#from '../models/#from '$R/src/models/#g" \
    -e "s#from '../runtime/#from '$R/src/runtime/#g" \
    -e "s#from './sse.ts'#from '$R/src/http/sse.ts'#" \
    -e "s#from './errors.ts'#from '$R/src/http/errors.ts'#" \
    $R/src/http/models-routes.ts > $D/m-routes.ts
sed -e "s#from '../src/http/models-routes.ts'#from './m-routes.ts'#" \
    -e "s#from '../src/#from '$R/src/#g" \
    $R/test/capability-override-routes.test.ts > $D/m-routes.test.ts
python3 -c "$1"
node --test $D/m-routes.test.ts 2>&1 | grep -E "^(ℹ (tests|pass|fail))" | tr '\n' ' '
echo "   <== $2"
