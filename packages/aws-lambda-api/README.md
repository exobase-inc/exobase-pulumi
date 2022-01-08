# `@exobase/pulumi-aws-lambda-api`

> Exobase pulumi package for creating resources in AWS that make up an API of lambda functions


## Install
```
yarn add --dev @exobase/pulumi-aws-lambda-api
```


## Usage

```ts
import { AWSLambdaAPI } from '@exobase/pulumi-aws-lambda-api'

new AWSLambdaAPI('my-api', {
  sourceDir: process.pwd(),
  sourceExt: 'ts',
  environmentVariables: [{
    name: 'LOG_LEVEL',
    value: 'debug'
  }]
})
```
