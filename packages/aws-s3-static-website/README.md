# `@exobase/pulumi-aws-s3-static-website`

> Exobase pulumi package for creating resources in AWS that make up a static website on S3


## Install
```
yarn add --dev @exobase/pulumi-aws-s3-static-website
```


## Usage

```ts
import { AWSS3StaticWebsite } from '@exobase/pulumi-aws-s3-static-website'

new AWSS3StaticWebsite('my-api', {
  sourceDir: process.pwd(),
  distDir: `${process.pwd()}/dist`
  preBuildCommand: 'yarn'
  buildCommand: 'yarn build'
})
```
