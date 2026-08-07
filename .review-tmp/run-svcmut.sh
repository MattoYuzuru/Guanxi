#!/bin/zsh
D=/Users/m.ryabushkin/Projects/alamo-ui/.review-tmp
R=/Users/m.ryabushkin/Projects/alamo-ui/packages/server
rm -f $D/ms-service.ts $D/ms-svc.ts $D/ms-store.ts $D/ms.test.ts
sed -e "s#from './db.ts'#from '$R/src/store/db.ts'#" $R/src/store/capability-override.ts > $D/ms-store.ts
sed -e "s#from '../runtime/#from '$R/src/runtime/#g" \
    -e "s#from '../store/capability-override.ts'#from './ms-store.ts'#" \
    -e "s#from '../store/#from '$R/src/store/#g" \
    -e "s#from '../ollama/#from '$R/src/ollama/#g" \
    -e "s#from '../hardware/#from '$R/src/hardware/#g" \
    -e "s#from './#from '$R/src/models/#g" \
    $R/src/models/service.ts > $D/ms-service.ts
sed -e "s#from './service.ts'#from './ms-service.ts'#" \
    -e "s#from '../runtime/observation-key.ts'#from '$R/src/runtime/observation-key.ts'#" \
    -e "s#from '../store/capability-override.ts'#from './ms-store.ts'#" \
    $R/src/models/capability-override.ts > $D/ms-svc.ts
sed -e "s#from '../src/models/capability-override.ts'#from './ms-svc.ts'#" \
    -e "s#from '../src/models/service.ts'#from './ms-service.ts'#" \
    -e "s#from '../src/store/capability-override.ts'#from './ms-store.ts'#" \
    -e "s#from '../src/#from '$R/src/#g" \
    $R/test/capability-override-service.test.ts > $D/ms.test.ts
python3 -c "$1"
node --test $D/ms.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)" | tr '\n' ' '
echo "   <== $2"
