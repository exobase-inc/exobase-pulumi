import _ from 'radash'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import mime from 'mime'
import fs from 'fs-extra'
import cmd from 'cmdish'
import path from 'path'


export type Args = {
  sourceDir: string
  distDir: string
  preBuildCommand: string
  buildCommand: string
  domain?: {
    domain: string
    fqd: string
    subdomain: string
  }
}

/**
 * Static website using Amazon S3, CloudFront, and Route53.
 */
export class AWSStaticWebsite extends pulumi.ComponentResource {

  readonly contentBucket: aws.s3.Bucket
  readonly cdn: aws.cloudfront.Distribution
  readonly aRecord?: aws.route53.Record
  readonly wwwaRecord?: aws.route53.Record

  /**
  * Creates a new static website hosted on AWS.
  * @param name  The _unique_ name of the resource.
  * @param contentArgs  The arguments to configure the content being served.
  * @param domainArgs  The arguments to configure the domain and DNS settings.
  * @param opts  A bag of options that control this resource's behavior.
  */
  constructor(
    name: string,
    args: Args,
    opts?: pulumi.ResourceOptions
  ) {
    const inputs: pulumi.Inputs = {
      options: opts
    }
    super("exo:components:aws-s3-static-website", name, inputs, opts)

    const {
      distDir,
      preBuildCommand,
      buildCommand,
      sourceDir,
      domain
    } = args
    const distributionDir = path.join(sourceDir, distDir)

    //
    //  BUILD SITE CONTENT
    //
    const build = buildSiteDistributionFolder({
      preBuildCommand,
      buildCommand,
      sourceDir
    })


    //
    //  CREATE BUCKET & ADD FILES FROM DIST
    //
    const bucket = new aws.s3.Bucket(`${_.dashCase(name)}-bucket`, {
      website: {
        indexDocument: 'index.html',
        errorDocument: '404.html'
      }
    }, opts)
    this.contentBucket = bucket

    // For each file in the directory, create an S3 object stored in `bucket`
    build.then(() => crawlDirectory(distributionDir, (filePath: string) => {
      const relativeFilePath = filePath.replace(distributionDir + '/', '')
      new aws.s3.BucketObject(relativeFilePath, {
        key: relativeFilePath,
        acl: 'public-read',
        bucket: bucket,
        contentType: mime.getType(filePath) || undefined,
        source: new pulumi.asset.FileAsset(filePath),
      }, {
        ...opts,
        parent: bucket,
      })
    }))


    //
    //  LOOKUP DOMAIN CERT
    //
    const useCustomDomain = !!domain
    const useWWWSubdomain = useCustomDomain && !!domain.subdomain
    const cert = (() => {
      if (domain) return undefined
      return pulumi.output(aws.acm.getCertificate({
        domain: domain.subdomain ? `*.${domain.domain}` : domain.domain,
        mostRecent: true,
        types: ["AMAZON_ISSUED"]
      }, opts))
    })()


    //
    //  CREATE CLOUDFRONT DISTRIBUTION
    //
    const tenMinutes = 60 * 10
    this.cdn = new aws.cloudfront.Distribution('cdn', {
      enabled: true,
      // Alternate aliases the CloudFront distribution can be reached at, 
      // in addition to https://xxxx.cloudfront.net. Required if you want 
      // to access the distribution via config.targetDomain as well.
      aliases: (() => {
        // If the custom domain specifies a subdomain then don't
        // create the www. alias.
        if (!useCustomDomain) return undefined
        if (!useWWWSubdomain) return [domain.fqd]
        return [domain.fqd, `www.${domain.domain}`]
      })(),

      // We only specify one origin for this distribution, the S3 content bucket.
      origins: [
        {
          originId: bucket.arn,
          domainName: bucket.websiteEndpoint,
          customOriginConfig: {
            // Amazon S3 doesn't support HTTPS connections when using an S3 bucket 
            // configured as a website endpoint.
            // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginProtocolPolicy
            originProtocolPolicy: "http-only",
            httpPort: 80,
            httpsPort: 443,
            originSslProtocols: ["TLSv1.2"]
          }
        }
      ],

      defaultRootObject: "index.html",

      // A CloudFront distribution can configure different cache behaviors 
      // based on the request path. Here we just specify a single, default 
      // cache behavior which is just read-only requests to S3.
      defaultCacheBehavior: {
        targetOriginId: bucket.arn,

        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],

        forwardedValues: {
          cookies: { forward: "none" },
          queryString: false
        },

        minTtl: 0,
        defaultTtl: tenMinutes,
        maxTtl: tenMinutes,
      },

      // "All" is the most broad distribution, and also the most expensive.
      // "100" is the least broad, and also the least expensive.
      priceClass: "PriceClass_100",

      // You can customize error responses. When CloudFront receives an error 
      // from the origin (e.g. S3 or some other web service) it can return a 
      // different error code, and return the response for a different resource.
      customErrorResponses: [{
        errorCode: 404,
        responseCode: 404,
        responsePagePath: "/404.html"
      }],

      restrictions: {
        geoRestriction: {
          restrictionType: "none"
        }
      },

      viewerCertificate: useCustomDomain ? {
        acmCertificateArn: cert?.arn,
        sslSupportMethod: "sni-only"
      } : undefined,

      // loggingConfig: {
      //   bucket: logsBucket.bucketDomainName,
      //   includeCookies: false,
      //   prefix: `${config.targetDomain}/`,
      // },
    }, opts)


    //
    //  SETUP CUSTOM DOMAIN/S (if specified)
    //
    if (useCustomDomain) {
      const zone = pulumi.output(aws.route53.getZone({
        name: domain.domain,
        privateZone: false
      }, opts))
      this.aRecord = new aws.route53.Record(domain.subdomain, {
        name: domain.subdomain,
        zoneId: zone.id,
        type: "A",
        aliases: [{
          name: this.cdn.domainName,
          zoneId: this.cdn.hostedZoneId,
          evaluateTargetHealth: true
        }]
      }, opts)
      if (useWWWSubdomain) {
        this.wwwaRecord = new aws.route53.Record(`${domain}-www-alias`, {
          name: `www.${domain}`,
          zoneId: zone.id,
          type: "A",
          aliases: [{
            name: this.cdn.domainName,
            zoneId: this.cdn.hostedZoneId,
            evaluateTargetHealth: true,
          }]
        }, opts)
      }
    }
  }
}


const buildSiteDistributionFolder = async ({
  sourceDir,
  preBuildCommand,
  buildCommand
}: {
  sourceDir: string
  preBuildCommand: string
  buildCommand: string
}) => {

  const USE_NVM = !!process.env.USE_NVM

  const nvmPre = USE_NVM
    ? `source ~/.nvm/nvm.sh && nvm use && `
    : ''

  // 
  // RUN PRE BUILD
  //
  if (!!preBuildCommand) {
    await cmd(`${nvmPre}${preBuildCommand}`, {
      cwd: sourceDir
    })
  }

  //
  // RUN BUILD
  //
  if (!!buildCommand) {
    await cmd(`${nvmPre}${buildCommand}`, {
      cwd: sourceDir
    })
  }
}

const crawlDirectory = (dir: string, f: (_: string) => void) => {
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const filePath = `${dir}/${file}`
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      crawlDirectory(filePath, f)
    }
    if (stat.isFile()) {
      f(filePath)
    }
  }
}