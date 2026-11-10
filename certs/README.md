# certs/

`rds-global-bundle.pem`: Amazon RDS's public root certificates for every region (114 roots, earliest expiry 2061),
from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, fetched 2026-11-10
(sha256 90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b). Public certificates, no keys.

Why: the database URL says `sslmode=require`, which node-postgres treats as full verification of the server's
certificate. RDS certificates chain to these roots, which aren't in Node's own store, so without them the app can't
connect to RDS at all. The image ships the file at `/app/certs/rds-global-bundle.pem`; on AWS the container sets
`NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem`. Nothing reads it unless that is set, so Fly and Neon (whose
certificates chain to public roots) are unchanged.

To refresh: download the same URL, check every certificate is an Amazon RDS CA (scripts/rds-ca-bundle.test.ts does),
and update the date and hash above.
