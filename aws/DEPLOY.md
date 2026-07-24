# Roadtrip Map — AWS deploy runbook (AWS CloudShell)

Everything runs in **AWS CloudShell**, which is already signed in as you — no
access keys to copy anywhere. Open the AWS Console, pick your region (e.g.
`eu-central-1` or `us-east-1`), then click the **CloudShell** icon in the top bar.

> You only need to do steps 1–6 once. Later app updates are just an `s3 sync`
> (step 7) and, for backend changes, `sam deploy` again.

---

## 1. Get the code

```bash
git clone https://github.com/tombolek/roadtrip-map.git
cd roadtrip-map/aws
```

## 2. Generate the signing key pair (for CloudFront signed cookies)

```bash
openssl genrsa -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

Keep `private_key.pem` private — it never leaves CloudShell except into Secrets
Manager, encrypted, during deploy.

## 3. Build

```bash
sam build
```

## 4. First deploy (leave the CloudFront domain blank for now)

```bash
sam deploy \
  --stack-name roadtrip \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
     CloudFrontPublicKey="$(cat public_key.pem)" \
     PrivateKeyPem="$(cat private_key.pem)"
```

This takes ~5–15 min the first time (CloudFront distributions are slow to
create). When it finishes, read the outputs:

```bash
aws cloudformation describe-stacks --stack-name roadtrip \
  --query "Stacks[0].Outputs" --output table
```

Note the values for **CloudFrontDomain**, **SiteBucketName**, and
**MediaBucketName**.

## 5. Second deploy — tell the API its own domain

Signed cookies must be scoped to the real CloudFront host, so re-deploy passing
the domain from step 4:

```bash
CF=$(aws cloudformation describe-stacks --stack-name roadtrip \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

sam deploy \
  --stack-name roadtrip \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
     CloudFrontPublicKey="$(cat public_key.pem)" \
     PrivateKeyPem="$(cat private_key.pem)" \
     CFDomain="$CF"
```

(This one is fast — only the Lambda config changes.)

## 6. Confirm the API is reachable

```bash
curl -s -X POST "https://$CF/api/auth" \
  -H "content-type: application/json" \
  -d '{"tripId":"nope","password":"x"}'
# expect: {"error":"not found"}
```

If you see that JSON, the whole chain (CloudFront → Lambda → DynamoDB) works.

---

## 7. Upload the web app  (do this in Phase 2, after the frontend is rewired)

Once the frontend is pointed at the new backend, publishing the site is:

```bash
SITE=$(aws cloudformation describe-stacks --stack-name roadtrip \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
DIST=$(aws cloudformation describe-stacks --stack-name roadtrip \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

aws s3 sync ../public/ "s3://$SITE/" --delete
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*"
```

Then open `https://<CloudFrontDomain>/` — that becomes the new home of the app,
replacing the Netlify URL.

---

## Tearing it down

```bash
# empty the buckets first, then:
aws cloudformation delete-stack --stack-name roadtrip
```

## Cost

At family scale this is cents/month: DynamoDB on-demand (negligible),
S3 storage ~\$0.02/GB, Lambda a few thousand invocations (free tier), and
CloudFront egress well within the 1 TB/month always-free allowance.
