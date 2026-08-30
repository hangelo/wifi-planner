# Hosting WiFi Planner on AWS

How to serve the contents of `website/` as a public HTTPS site: a private S3
bucket behind CloudFront, with TLS from ACM and DNS from Route 53. There is no
build step — the files are uploaded as they are.

```
Route 53 (A + AAAA alias)
        │
        ▼
CloudFront  ──── ACM certificate (us-east-1)
        │
        │  Origin Access Control, SigV4-signed
        ▼
S3 bucket  (private, no public access)
```

The bucket is never public. It has no website hosting and no public-read
policy; the only thing allowed to read it is one named CloudFront distribution,
and the bucket policy says so explicitly. Requests sent straight to the S3
endpoint return `AccessDenied`.

## Before you start

AWS CLI v2, authenticated with permissions for S3, CloudFront, ACM and Route 53,
and the parent domain already in a Route 53 public hosted zone.

Set these once and the rest of the document is copy-paste. No real values are
committed to this repository — substitute your own.

```bash
BUCKET=your-bucket-name              # globally unique
REGION=ca-central-1                  # where the bucket lives
DOMAIN=planner.example.com           # the hostname you want to serve
ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='example.com.'].Id" --output text | cut -d/ -f3)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

Three more come from the steps below as you go: `CERT_ARN` (step 2), `OAC_ID`
(step 3), and `DIST_ID` / `DIST_DOMAIN` (step 4).

## 1. The bucket

Create it private and leave it that way.

```bash
aws s3api create-bucket --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

aws s3api put-public-access-block --bucket "$BUCKET" \
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
CERT_ARN=$(aws acm request-certificate --region us-east-1 \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --query CertificateArn --output text)
```

Read back the validation record ACM wants:

```bash
aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add that CNAME to the hosted zone — same `change-batch` shape as step 7, with
`"Type": "CNAME"`, `"TTL": 300` and the name and value ACM just gave you — then:

```bash
aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT_ARN"
```

Issuance normally takes a minute or two. Leave the validation CNAME in the zone
permanently: ACM re-checks it to renew the certificate automatically, and
deleting it will eventually break renewal.

## 3. Origin Access Control

OAC is how CloudFront proves to S3 that a request came from this distribution.
It replaces the older Origin Access Identity.

```bash
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config "{
    \"Name\": \"$BUCKET-oac\",
    \"Description\": \"OAC for $BUCKET\",
    \"SigningProtocol\": \"sigv4\",
    \"SigningBehavior\": \"always\",
    \"OriginAccessControlOriginType\": \"s3\"
  }" --query 'OriginAccessControl.Id' --output text)
```

## 4. The distribution

```bash
cat > dist.json <<EOF
{
  "CallerReference": "$DOMAIN-$(date +%s)",
  "Aliases": {"Quantity":1,"Items":["$DOMAIN"]},
  "DefaultRootObject": "index.html",
  "Origins": {"Quantity":1,"Items":[{
    "Id":"s3-origin",
    "DomainName":"$BUCKET.s3.$REGION.amazonaws.com",
    "OriginPath":"",
    "CustomHeaders":{"Quantity":0},
    "S3OriginConfig":{"OriginAccessIdentity":""},
    "OriginAccessControlId":"$OAC_ID",
    "ConnectionAttempts":3,"ConnectionTimeout":10,
    "OriginShield":{"Enabled":false}
  }]},
  "OriginGroups":{"Quantity":0},
  "DefaultCacheBehavior":{
    "TargetOriginId":"s3-origin",
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
  "Comment":"static site",
  "Logging":{"Enabled":false,"IncludeCookies":false,"Bucket":"","Prefix":""},
  "PriceClass":"PriceClass_100",
  "Enabled":true,
  "ViewerCertificate":{
    "ACMCertificateArn":"$CERT_ARN",
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

read DIST_ID DIST_DOMAIN < <(aws cloudfront create-distribution \
  --distribution-config file://dist.json \
  --query 'Distribution.[Id,DomainName]' --output text)
```

`658327ea-f89d-4fab-a63d-7e88639e58f6` is the AWS-managed **CachingOptimized**
policy — a fixed public ID, the same in every account.

The 403/404 rewrites exist because a private bucket answers a missing key with
`AccessDenied`, not `NotFound`; without them a mistyped path would show raw S3
XML. The trade-off is that a bad path returns the app with HTTP 200 rather than
a real 404. Drop `CustomErrorResponses` if you would rather have honest 404s.

## 5. Let CloudFront read the bucket

Only after the distribution exists, because the policy names its ARN.

```bash
cat > policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": {"StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID"
    }}
  }]
}
EOF

aws s3api put-bucket-policy --bucket "$BUCKET" --policy file://policy.json
```

The `SourceArn` condition is what keeps the grant narrow — a different
distribution, even in the same account, cannot read the bucket.

## 6. Upload

Content types matter: S3 will otherwise serve the JS as
`application/octet-stream` and the browser will refuse to execute it.

```bash
cd website

for f in index.html terms.html; do
  aws s3 cp "$f" "s3://$BUCKET/$f" \
    --content-type "text/html; charset=utf-8" \
    --cache-control "public, max-age=0, must-revalidate"
done

for f in app.js planimport.js importui.js consent.js; do
  aws s3 cp "$f" "s3://$BUCKET/$f" \
    --content-type "text/javascript; charset=utf-8" \
    --cache-control "public, max-age=300"
done

aws s3 cp styles.css "s3://$BUCKET/styles.css" \
  --content-type "text/css; charset=utf-8" \
  --cache-control "public, max-age=300"
```

The filenames are not content-hashed, so the caching is deliberately short: the
HTML revalidates on every request and the assets expire after five minutes. A
redeploy therefore goes live within five minutes with no invalidation. Hash the
filenames if you ever want long-lived caching.

## 7. DNS

Alias records, not CNAMEs — a CNAME cannot sit at a name that also answers other
record types, and aliases cost nothing to resolve. `Z2FDTNDATAQYW2` is
CloudFront's fixed hosted-zone ID, identical for every distribution in every
account; it is not specific to you.

```bash
cat > dns.json <<EOF
{
  "Comment": "$DOMAIN -> CloudFront",
  "Changes": [
    {"Action":"UPSERT","ResourceRecordSet":{
      "Name":"$DOMAIN.","Type":"A",
      "AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2",
                     "DNSName":"$DIST_DOMAIN.","EvaluateTargetHealth":false}}},
    {"Action":"UPSERT","ResourceRecordSet":{
      "Name":"$DOMAIN.","Type":"AAAA",
      "AliasTarget":{"HostedZoneId":"Z2FDTNDATAQYW2",
                     "DNSName":"$DIST_DOMAIN.","EvaluateTargetHealth":false}}}
  ]
}
EOF

aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch file://dns.json
```

## 8. Verify

The distribution takes roughly five minutes to reach `Deployed`.

```bash
aws cloudfront wait distribution-deployed --id "$DIST_ID"

curl -sSI "https://$DOMAIN/" | head -1
curl -sS -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "http://$DOMAIN/"

# must be 403 — proves the bucket is not readable directly
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://s3.$REGION.amazonaws.com/$BUCKET/index.html"
```

Expected: `200` over HTTPS, `301` from HTTP, `403` straight to S3.

## Redeploying

```bash
aws s3 sync website/ "s3://$BUCKET" --delete
```

`sync` does not set content types the way the explicit `cp` calls above do — it
guesses from the extension, which is correct for `.html`, `.js` and `.css`. To
publish immediately instead of waiting out the five-minute TTL:

```bash
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"
```

The first 1,000 invalidation paths each month are free.

## Cost

Effectively nothing at this size: ACM certificates are free, CloudFront's
perpetual free tier covers 1 TB out and 10M requests a month, S3 holds a couple
of hundred kilobytes, and a hosted zone is $0.50/month whether or not this
subdomain exists. `PriceClass_100` restricts edge locations to North America and
Europe, the cheapest tier; use `PriceClass_All` to serve Asia-Pacific and South
America locally too.

## Tearing it down

Order matters — the distribution has to be disabled and fully deployed before
CloudFront will let you delete it, which takes several minutes.

```bash
# 1. disable, wait, then delete the distribution (needs its current ETag)
# 2. aws s3 rm "s3://$BUCKET" --recursive
# 3. aws s3api delete-bucket --bucket "$BUCKET"
# 4. delete the A, AAAA and ACM validation records from the hosted zone
# 5. aws acm delete-certificate --region us-east-1 --certificate-arn "$CERT_ARN"
```

## What does not belong in this repository

Nothing in this file names a real bucket, distribution, certificate, hosted zone
or account. Those values live in the AWS console and in your shell, and there is
no reason for them to be in version control: an account ID makes IAM role
enumeration easier, and a bucket name tells someone exactly what to probe.

Credentials never go near a repository at all — use `aws configure`, an SSO
profile, or an instance role.
