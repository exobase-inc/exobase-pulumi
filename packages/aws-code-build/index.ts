import _ from 'radash'
import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import fs from 'fs-extra'
import cmd from 'cmdish'


export type Args = {
  /**
   * The directory where the source exists locally on disk. If
   * using this component with Exobase, the source is provided
   * by the Exobase build service.
   */
  sourceDir: string
  /**
   * The maximum time (in minutes) the build is allowed to run
   * before AWS will kill it. Value must be between 5 and 480.
   */
  buildTimeoutSeconds: number
  /**
   * The command to run at the command line to execute the build.
   * Example: yarn run build-script
   */
  buildCommand: string
  /**
   * The Docker image to run the build on. Choose one that includes
   * all the dependencies your build process will need.
   * Example: node:16
   */
  image: string
  /**
   * These will be available to your process when the build is
   * executed.
   */
  environmentVariables: {
    name: string
    value: string
  }[]
}

/**
 * Static website using Amazon S3, CloudFront, and Route53.
 */
export class AWSCodeBuildProject extends pulumi.ComponentResource {

  readonly project: aws.codebuild.Project

  constructor(
    name: string,
    args: Args,
    opts?: pulumi.ResourceOptions
  ) {
    const inputs: pulumi.Inputs = {
      options: opts
    }
    super('exo:components:aws-code-build-project', name, inputs, opts)


    //
    //  CREATE SOURCE ZIP
    //
    const zip = buildSourceZip(args)


    //
    // CREATE BUCKET & STORE SOURCE
    //
    const bucketName = _.dashCase(`${name}-source`)
    const bucket = new aws.s3.Bucket(bucketName, {
      acl: 'private'
    }, opts)
    new aws.s3.BucketObject(`source.zip`, {
      key: 'source.zip',
      bucket: bucket,
      contentType: 'application/zip',
      source: new pulumi.asset.FileAsset(zip),
    }, {
      ...opts,
      parent: bucket,
    })


    //
    //  CREATE ROLE/POLICY
    //
    const { role } = createRolePolicy({ bucket, opts })


    //
    //  CREATE CODE BUILD PROJECT
    //
    this.project = new aws.codebuild.Project(_.dashCase(name), {
      buildTimeout: args.buildTimeoutSeconds,
      serviceRole: role.arn,
      artifacts: {
        type: "NO_ARTIFACTS"
      },
      environment: {
        computeType: "BUILD_GENERAL1_SMALL",
        image: args.image,
        type: "LINUX_CONTAINER",
        imagePullCredentialsType: "CODEBUILD",
        environmentVariables: args.environmentVariables
      },
      logsConfig: {
        cloudwatchLogs: {
          groupName: "log-group",
          streamName: _.dashCase(name),
        }
      },
      source: {
        type: "S3",
        location: `${bucketName}/source.zip`
      }
    }, opts)
  }
}

const createRolePolicy = ({ 
  bucket, 
  opts 
}: { 
  bucket: aws.s3.Bucket, 
  opts?: pulumi.ResourceOptions 
}) => {
  const role = new aws.iam.Role("main", {
    assumeRolePolicy: `{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "codebuild.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }
  `}, opts);
  const policy = new aws.iam.RolePolicy("main", {
    role: role.name,
    policy: pulumi.interpolate`{
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Resource": [
            "*"
          ],
          "Action": [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ]
        },
        {
          "Effect": "Allow",
          "Action": [
            "s3:*"
          ],
          "Resource": [
            "${bucket.arn}",
            "${bucket.arn}/*"
          ]
        }
      ]
    }`
  }, opts)
  return { role, policy }
}


const buildSourceZip = async (args: Args): Promise<string> => {

  const zip = `${args.sourceDir}/source.zip`

  //
  // Read and update the buildspec
  //
  const buildspecTemplate = await fs.readFile(`${__dirname}/buildspec.yml`, 'utf-8')
  const buildspec = buildspecTemplate.replace('{{command}}', args.buildCommand)
  await fs.writeFile(`${__dirname}/source/buildspec.yml`, buildspec)

  //
  // Generate zip
  //
  await cmd(`zip -q -r ${zip} *`, {
    cwd: args.sourceDir
  })

  return zip
}
