# `@exobase/pulumi-aws-code-build`

> Exobase pulumi package for creating AWS Code Build resources

This Pulumi component is designed specifically for the `task-runner` service type at [Exobase](https://exobase.cloud). Because of that, here are some of the main features of this component:

1. The source is packaged and stored in S3. When a build is executed it will run the command specified by `args.buildCommand` in the root of your source directory. If your using this on Exobase, the source is provided by the Exobase build runner.
2. It is assumed the build/task will be run many times per deployment. Because of this, any dependencies should be installed in your source before initilizing this component. This component assumes all dependencies are installed in the givesn source directory. i.e. there is no install dependencies step added to the build config.


## Install
```
yarn add --dev @exobase/pulumi-aws-code-build
```

## Usage

```ts
import { AWSLambdaAPI } from '@exobase/pulumi-aws-code-build'

new AWSLambdaAPI('my-api', {
  sourceDir: process.pwd(),
  sourceExt: 'ts',
  environmentVariables: [{
    name: 'LOG_LEVEL',
    value: 'debug'
  }]
})
```
