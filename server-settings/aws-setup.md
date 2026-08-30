# Hosting WiFi Planner on AWS

How `wifiplanner.handcraftingcodes.com` is served: a private S3 bucket behind
CloudFront, with TLS from ACM and DNS from Route 53. Nothing in `website/`
needs a build step — the five files are uploaded as they are.

```
Route 53 (A + AAAA alias)
        │
        ▼
CloudFront  ──── ACM certificate (us-east-1)
        │
        │  Origin Access Control, SigV4-signed
        ▼
S3 bucket  wifiplanner.website  (private, no public access)
```

The bucket is never public. It has no website hosting and no public-read
policy; the only thing allowed to read it is this one CloudFront distribution,
and the bucket policy names it explicitly. Requests sent straight to the S3
endpoint return `AccessDenied`.

## Before you start

- AWS CLI v2, authenticated with permissions for S3, CloudFront, ACM and Route 53.
- The parent domain already in a Route 53 public hosted zone.
- Values you will need to substitute:

| Placeholder | Where to find it |
|---|---|
| `<ACCOUNT_ID>` | `aws sts get-caller-identity --query Account --output text` |
| `<ZONE_ID>` | `aws route53 list-hosted-zones` — the zone for the parent domain |
| `<CERT_ARN>` | output of step 2 |
| `<OAC_ID>` | output of step 3 |
| `<DIST_ID>`, `<DIST_DOMAIN>` | output of step 4 |

Constants used below: bucket `wifiplanner.website` in `ca-central-1`, site
`wifiplanner.handcraftingcodes.com`.

## 1. The bucket

Create it private and leave it that way.

```bash
aws s3api create-bucket --bucket wifiplanner.website \
  --region ca-central-1 \
  --create-bucket-configuration LocationConstraint=ca-central-1

aws s3api put-public-access-block --bucket wifiplanner.website \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Do **not** enable static website hosting. That feature only speaks HTTP and
would force the bucket to be public; CloudFront reads the bucket through its
REST endpoint instead.

## 2. The certificate

CloudFront only accepts certificates from **us-east-1**, whatever region
everything else lives in.

```bash
aws acm request-certificate --region us-east-1 \
  --domain-name wifiplanner.handcraftingcodes.com \
  --validation-method DNS \
  --query CertificateArn --output text
```

Read back the validation record ACM wants:

```bash
aws acm describe-certificate --region us-east-1 --certificate-arn <CERT_ARN> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add that CNAME to the hosted zone (`change-batch` shape as in step 7, with
`"Type": "CNAME"`, `"TTL": 300` and the value ACM gave you), then wait:

```bash
aws acm wait certificate-validated --region us-east-1 --certificate-arn <CERT_ARN>
```

Issuance normally takes a minute or two. Leave the validation CNAME in the zone
permanently — ACM re-checks it to renew the certificate automatically, and
deleting it will eventually break renewal.

## 3. Origin Access Control

OAC is how CloudFront proves to S3 that a request came from this distribution.
It replaces the older Origin Access Identity.

```bash
aws cloudfront create-origin-access-control --origin-access-control-config '{
  "Name": "wifiplanner-oac",
  "Description": "OAC for wifiplanner.website bucket",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}' --query 'OriginAccessControl.Id' --output text
```

## 4. The distribution

```bash
cat > dist.json <<EOF
{
  "CallerReference": "wifiplanner-$(date +%s)",
  "Aliases": {"Quantity":1,"Items":["wifiplanner.handcraftingcodes.com"]},
  "DefaultRootObject": "index.html",
  "Origins": {"Quantity":1,"Items":[{
    "Id":"s3-wifiplanner",
    "DomainName":"wifiplanner.website.s3.ca-central-1.amazonaws.com",
    "OriginPath":"",
    "CustomHeaders":{"Quantity":0},
    "S3OriginConfig":{"OriginAccessIdentity":""},
    "OriginAccessControlId":"<OAC_ID>",
    "ConnectionAttempts":3,"ConnectionTimeout":10,
    "OriginShield":{"Enabled":false}
  }]},
  "OriginGroups":{"Quantity":0},
  "DefaultCacheBehavior":{
    "TargetOriginId":"s3-wifiplanner",
    "ViewerProtocolPolicy":"redirect-to-https",
    "AllowedMethods":{"Quantity":2,"Items":["HEAD","GET"],
                      "CachedMethods":{"Quantity":2,"Items":["HEAD","GET"]}},
    "Compress":true,
    "CachePolicyId":"658327ea-f89d-4fab-a63d-7e88639e58f6",
    "SmoothStreaming":false,
    "FieldLevelEncryptionId":"",
    "LambdaFunctionAssociations":{"Quantity":0},
    "FunctionAssociations":{"Quantity":0},
    "TrustedSigners":{"Enabled":false,"Quantity":0},
    "TrustedKeyGroups":{"Enabled":false,"Quantity":0}
  },
  "CacheBehaviors":{"Quantity":0},
  "CustomErrorResponses":{"Quantity":2,"Items":[
    {"ErrorCode":403,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":60},
    {"ErrorCode":404,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":60}
  ]},
  "Comment":"WiFi Planner static site",
  "Logging":{"Enabled":false,"IncludeCookies":false,"Bucket":"","Prefix":""},
  "PriceClass":"PriceClass_100",
  "Enabled":true,
  "ViewerCertificate":{
    "ACMCertificateArn":"<CERT_ARN>",
    "SSLSupportMethod":"sni-only",
    "MinimumProtocolVersion":"TLSv1.2_2021",
    "CloudFrontDefaultCertificate":false
  },
  "Restrictions":{"GeoRestriction":{"RestrictionType":"none","Quantity":0}},
  "WebACLId":"",
  "HttpVersion":"http2and3",
  "IsIPV6Enabled":true
}
EOF

aws cloudfront create-distribution --distribution-config file://dist.json \
  --query 'Distribution.{Id:Id,Domain:DomainName}'
```

`658327ea-f89d-4fab-a63d-7e88639e58f6` is the AWS-managed **CachingOptimized**
policy. The 403/404 rewrites exist because a private bucket answers a missing
key with `AccessDenied`, not `NotFound`; without them a mistyped path would
show raw S3 XML. The trade-off is that a bad path returns the app with HTTP 200
rather than a real 404.

## 5. Let CloudFront read the bucket

Only after the distribution exists, because the policy names its ARN.

```bash
cat > policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::wifiplanner.website/*",
    "Condition": {"StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DIST_ID>"
    }}
  }]
}
EOF

aws s3api put-bucket-policy --bucket wifiplanner.website --policy file://policy.json
```

The `SourceArn` condition is what keeps the grant narrow — a different
distribution, even in the same account, cannot read the bucket.

## 6. Upload

Content types matter: S3 will otherwise serve the JS as
`application/octet-stream` and the browser will refuse to execute it.

```bash
cd website

aws s3 cp index.html s3://wifiplanner.website/index.html \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public, max-age=0, must-revalidate"

for f in app.js planimport.js importui.js; do
  aws s3 cp "$f" "s3://wifiplanner.website/$f" \
    --content-type "text/javascript; charset=utf-8" \
    --cache-control "public, max-age=300"
done

aws s3 cp styles.css s3://wifiplanner.website/styles.css \
  --content-type "text/css; charset=utf-8" \
  --cache-control "public, max-age=300"
```

The filenames are not content-hashed, so the caching is deliberately short:
`index.html` revalidates on every request and the assets expire after five
minutes. A redeploy therefore goes live within five minutes with no
invalidation. Hash the filenames if you ever want long-lived caching.

## 7. DNS

Alias records, not CNAMEs — a CNAME cannot sit at a name that also needs to
answer other record types, and aliases are free to resolve. `Z2FDTNDATAQYW2` is
CloudFront's fixed hosted-zone ID; it is the same for every distribution in
every account.

```bash
cat > dns.json <<'EOF'
{
  "Comment": "wifiplanner -> CloudFront",
  "Changes": [
    {"Action":"UPSERT","ResourceRecordSet":{
      "Name":"wifiplanner.handcraftingcodes.com.","Type":"A",
      "AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2",
                     "DNSName":"<DIST_DOMAIN>.","EvaluateTargetHealth":false}}},
    {"Action":"UPSERT","ResourceRecordSet":{
      "Name":"wifiplanner.handcraftingcodes.com.","Type":"AAAA",
      "AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2",
                     "DNSName":"<DIST_DOMAIN>.","EvaluateTargetHealth":false}}}
  ]
}
EOF

aws route53 change-resource-record-sets --hosted-zone-id <ZONE_ID> \
  --change-batch file://dns.json
```

## 8. Verify

The distribution takes roughly five minutes to reach `Deployed`.

```bash
aws cloudfront wait distribution-deployed --id <DIST_ID>

curl -sSI https://wifiplanner.handcraftingcodes.com/ | head -1
curl -sS -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  http://wifiplanner.handcraftingcodes.com/

# must be 403 — proves the bucket is not readable directly
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://s3.ca-central-1.amazonaws.com/wifiplanner.website/index.html
```

Expected: `200` over HTTPS, `301` from HTTP, `403` straight to S3.

## Redeploying

```bash
aws s3 sync website/ s3://wifiplanner.website --delete
```

`sync` does not set content types the way the explicit `cp` calls above do — it
guesses from the extension, which is correct for `.html`, `.js` and `.css`. To
publish immediately instead of waiting out the five-minute TTL:

```bash
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

The first 1,000 invalidation paths each month are free.

## Cost

Effectively nothing at this size: ACM certificates are free, CloudFront's
perpetual free tier covers 1 TB out and 10M requests a month, S3 holds about
140 KB, and the hosted zone is $0.50/month whether or not this subdomain exists.
`PriceClass_100` restricts edge locations to North America and Europe, which is
the cheapest tier; widen it to `PriceClass_All` if you want Asia-Pacific and
South America served locally.

## Tearing it down

Order matters — the distribution has to be disabled and fully deployed before
CloudFront will let you delete it, which takes several minutes.

```bash
# 1. disable, wait, then delete the distribution (needs its current ETag)
# 2. aws s3 rm s3://wifiplanner.website --recursive
# 3. aws s3api delete-bucket --bucket wifiplanner.website
# 4. delete the A, AAAA and ACM validation records from the hosted zone
# 5. aws acm delete-certificate --region us-east-1 --certificate-arn <CERT_ARN>
```
