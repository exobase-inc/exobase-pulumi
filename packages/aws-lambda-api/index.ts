import _ from 'radash'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'
import fs from 'fs-extra'
import cmd from 'cmdish'
import path from 'path'


export type LanguageExtension = 'ts' | 'py' | 'go' | 'cs' | 'js' | 'swift'

export type Args = {
  sourceDir: string
  sourceExt: LanguageExtension
  environmentVariables: {
    name: string
    value: string
  }[]
  domain?: {
    domain: string
    fqd: string
    subdomain: string
  }
}

/**
 * Static website using Amazon S3, CloudFront, and Route53.
 */
export class AWSLambdaAPI extends pulumi.ComponentResource {

  readonly api: aws.apigateway.RestApi
  readonly lambdas: aws.lambda.Function[]
  readonly aRecord?: aws.route53.Record

  constructor(
    name: string,
    args: Args,
    opts?: pulumi.ResourceOptions
  ) {
    const inputs: pulumi.Inputs = {
      options: opts
    }
    super('exo:components:aws-lambda-api', name, inputs, opts)

    const apiName = _.dashCase(`${name}-api`)
    const iamRoleName = _.dashCase(`${name}-iam-lambda`)
    /** 
     * aws component will add a dash and 7 rand chars to our name and
     * the aws limit is 64. We need to trim it if its over
     * limit = 64 - (dash = 1) - (rand = 7)
     */
    const lambdaName = (module: string, func: string) => {
      const n = _.dashCase(`${name}-${module}-${func}`)
      return n.length > 56
        ? n.slice(0, 56 - n.length)
        : n
    }


    //
    //  DETERMINE API SHAPE FROM SOURCE
    //
    const functions = getFunctionMap({
      path: args.sourceDir,
      ext: args.sourceExt
    })


    //
    //  BUILD NEEDED FUNCTIONS
    //
    const zipPath = buildTypescriptLambdaZip({
      path: args.sourceDir
    })


    //
    //  CREATE NEEDED ROLE/POLICY
    //
    const iamForLambda = new aws.iam.Role(iamRoleName, {
      assumeRolePolicy: `{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Action": "sts:AssumeRole",
          "Principal": {
            "Service": "lambda.amazonaws.com"
          },
          "Effect": "Allow",
          "Sid": ""
        }
      ]
    }`
    }, opts)
    const lambdaLoggingPolicy = new aws.iam.Policy("lambdaLogging", {
      path: "/",
      description: "IAM policy for logging from a lambda",
      policy: `{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Action": [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ],
          "Resource": "arn:aws:logs:*:*:*",
          "Effect": "Allow"
        }
      ]
    }
    `
    }, opts)
    const loggingPolicyAttachment = new aws.iam.RolePolicyAttachment("lambdaLogs", {
      role: iamForLambda.name,
      policyArn: lambdaLoggingPolicy.arn,
    }, opts)


    //
    //  CREATE LAMBDA FOR EACH FUNCTION
    //
    const zipSource = new pulumi.asset.FileArchive(zipPath)
    const envvars = args.environmentVariables.reduce((acc, envvar) => ({
      ...acc,
      [envvar.name]: envvar.value
    }), {})
    const lambdas = functions.map((func) => {
      const lambda = new aws.lambda.Function(lambdaName(func.module, func.function), {
        code: zipSource,
        role: iamForLambda.arn,
        handler: `modules/${func.module}/${func.function}.default`,
        runtime: 'nodejs14.x',
        environment: {
          variables: envvars
        }
      }, {
        ...opts,
        dependsOn: [
          loggingPolicyAttachment
        ]
      })
      return {
        ...func,
        lambda
      }
    })
    this.lambdas = lambdas.map(l => l.lambda)


    //
    //  CREATE API GATEWAY ENDPOINTS FOR EACH FUNCTION
    //
    const api = new awsx.apigateway.API(apiName, {
      routes: lambdas.map(lambda => ({
        path: `/${lambda.module}/${lambda.function}`,
        method: 'ANY',
        eventHandler: lambda.lambda,
      })),
      stageName: 'api'
    }, opts)
    this.api = api.restAPI


    //
    //  SETUP CUSTOM DOMAIN (if specified)
    //
    if (args.domain) {
      const cert = pulumi.output(aws.acm.getCertificate({
        domain: args.domain.subdomain
          ? `*.${args.domain.domain}`
          : args.domain.domain,
        mostRecent: true,
        types: ["AMAZON_ISSUED"]
      }, opts))
      const domainName = new aws.apigateway.DomainName(_.dashCase(args.domain.fqd), {
        certificateArn: cert.arn,
        domainName: args.domain.fqd
      }, opts)
      new aws.apigateway.BasePathMapping(_.dashCase(`${args.domain.fqd}-mapping`), {
        restApi: api.restAPI,
        stageName: api.stage.stageName,
        domainName: domainName.domainName
      }, opts)
      const zone = pulumi.output(aws.route53.getZone({
        name: args.domain.domain,
        privateZone: false
      }, opts))
      /**
       * Really odd use of cloud front args here. See this terraform
       * doc for clarification. TLDR; api gateway is using cloud front
       * under the hood.
       * https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_domain_name
       */
      this.aRecord = new aws.route53.Record(_.dashCase(`${args.domain.fqd}-record`), {
        zoneId: zone.id,
        name: domainName.domainName,
        type: "A",
        aliases: [{
          name: domainName.cloudfrontDomainName,
          zoneId: domainName.cloudfrontZoneId,
          evaluateTargetHealth: false
        }]
      }, {
        ...opts, dependsOn: [
          domainName
        ]
      })
    }
  }
}


const buildTypescriptLambdaZip = async ({
  path
}: {
  path: string
}): Promise<string> => {

  const root = path
  const build = `${root}/build`
  const zip = `${root}/aws-lambda-api.zip`

  const USE_NVM = !!process.env.USE_NVM

  //
  // Add files and install dependencies
  //
  await fs.copy(`${root}/package.json`, `${build}/package.json`)
  if (USE_NVM) {
    const [err] = await cmd('source ~/.nvm/nvm.sh && nvm use && yarn && yarn build && cd build && yarn --prod', { cwd: root })
    if (err) throw err
  } else {
    const [err] = await cmd('yarn && yarn build && cd build && yarn --prod', { cwd: root })
    if (err) throw err
  }

  //
  // Generate new zip
  //
  await cmd(`zip -q -r ${zip} *`, { cwd: build })

  return zip
}

export type Function = {
  name: string
  module: string
  path: string
  route: string
}

type ModuleFunction = {
  function: string
  module: string
  paths: {
    import: string
    file: string
  }
}

/**
 * Looks in ./src/modules for your modules and
 * functions. Returns their names and locations
 * as an array.
 */
export function getFunctionMap({
  path: rootPath,
  ext
}: {
  path: string
  ext: LanguageExtension
}): ModuleFunction[] {
  const relPath = (rel: string) => path.join(rootPath, rel)
  const modules = fs.readdirSync(relPath('/src/modules'), { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(m => {
      return fs.readdirSync(relPath(`/src/modules/${m.name}`), { withFileTypes: true })
        .filter(item => !item.isDirectory())
        .filter(item => item.name.endsWith(`.${ext}`))
        .map(tsFile => {
          const funcName = tsFile.name.replace(`.${ext}`, '')
          return {
            function: funcName,
            module: m.name,
            paths: {
              file: relPath(`/src/modules/${m.name}/${tsFile.name}`),
              import: relPath(`/src/modules/${m.name}/${funcName}`)
            }
          }
        }) as ModuleFunction[]
    })
  return _.flat(modules)
}