# Custom domain — trips.tombolek.com

Do this **after** `tombolek.com` registration shows `SUCCESSFUL` and you've
clicked the registrant verification email. Everything runs in CloudShell.
The ACM cert for CloudFront **must** be in `us-east-1`.

## 0. Handy variables

```bash
DOMAIN=trips.tombolek.com
ZONE=$(aws route53 list-hosted-zones-by-name --dns-name tombolek.com \
  --query "HostedZones[0].Id" --output text | sed 's#/hostedzone/##')
echo "hosted zone: $ZONE"
```

## 1. Request the certificate (us-east-1, DNS validation)

```bash
CERT=$(aws acm request-certificate --region us-east-1 \
  --domain-name "$DOMAIN" --validation-method DNS \
  --query CertificateArn --output text)
echo "cert: $CERT"
```

## 2. Add the validation record to Route 53

```bash
# read the validation CNAME ACM wants (wait a few seconds after step 1 if empty)
read VNAME VVALUE < <(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT" \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]" --output text)
echo "$VNAME -> $VVALUE"

cat > val.json <<JSON
{ "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": {
  "Name": "$VNAME", "Type": "CNAME", "TTL": 300,
  "ResourceRecords": [ { "Value": "$VVALUE" } ] } } ] }
JSON
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch file://val.json

# wait until the cert is issued (a few minutes)
aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT"
echo "certificate issued"
```

## 3. Attach the domain to CloudFront (re-deploy with the new params)

```bash
cd ~/roadtrip-map/aws
sam deploy --stack-name roadtrip --resolve-s3 --capabilities CAPABILITY_IAM \
  --parameter-overrides \
     CloudFrontPublicKey=/roadtrip/cf-public-key \
     PrivateKeySecretArn="$(aws secretsmanager describe-secret --secret-id roadtrip/cf-private-key --query ARN --output text)" \
     CustomDomain="$DOMAIN" \
     AcmCertArn="$CERT" \
     CFDomain="$DOMAIN"
```

> Note: `CFDomain` switches to the custom host so signed cookies are scoped to
> `trips.tombolek.com`. After this, share links use the new domain; old
> `*.cloudfront.net` image links stop authorizing (clean cutover to the domain).

## 4. Point DNS at CloudFront

```bash
CFDOM=$(aws cloudformation describe-stacks --stack-name roadtrip \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

cat > alias.json <<JSON
{ "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": {
  "Name": "$DOMAIN", "Type": "A",
  "AliasTarget": { "HostedZoneId": "Z2FDTNDATAQYW2", "DNSName": "$CFDOM", "EvaluateTargetHealth": false } } } ] }
JSON
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE" --change-batch file://alias.json
```

(`Z2FDTNDATAQYW2` is CloudFront's fixed hosted-zone ID — same for every distribution.)

## 5. Done

Wait a few minutes for DNS + the CloudFront update, then open
`https://trips.tombolek.com`. Re-publish/re-share trips so family gets the new
links. The old `*.cloudfront.net` URL still loads the app, but use the domain
going forward.
