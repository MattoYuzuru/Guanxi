#!/bin/zsh
# Mutates a COPY of the contract in .review-tmp; never touches the tracked repo file.
D=/Users/m.ryabushkin/Projects/alamo-ui/.review-tmp
C=/Users/m.ryabushkin/Projects/alamo-ui/packages/contract/src
rm -f $D/c-schemas.ts $D/c-api.ts $D/c-contract.test.ts
cp $C/schemas.ts $D/c-schemas.ts
sed -e "s#from './schemas.ts'#from './c-schemas.ts'#" $C/api.ts > $D/c-api.ts
# route the test's @alamo/contract import at the mutated copies
python3 - <<PY
src=open('/Users/m.ryabushkin/Projects/alamo-ui/packages/server/test/capability-override-contract.test.ts').read()
src=src.replace("} from '@alamo/contract'","} from './c-both.ts'")
open('$D/c-contract.test.ts','w').write(src)
open('$D/c-both.ts','w').write("export * from './c-schemas.ts'\nexport * from './c-api.ts'\n")
PY
python3 -c "$1"
node --test $D/c-contract.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)" | tr '\n' ' '
echo "   <== $2"
