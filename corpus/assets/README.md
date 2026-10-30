# corpus/assets

`labels.json` holds, for every synthetic fixture, its expected diagnostic codes and verdict, the gate options it is run with, and the SHA-256 of the GLB it generates. The GLBs themselves are generated into a gitignored folder by `pnpm fixtures`, which fails if a regenerated file does not reproduce its committed hash.
