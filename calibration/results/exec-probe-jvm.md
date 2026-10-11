# Execution-model probe: exec-probe-jvm

Analyzed commit shown per repository. Hook marked * runs for dependents when building from source. A probe, not a calibration metric.

## apache/commons-lang @ dd2c9e8578 (34706 ms, 56 requests, scan 0% / 45 files)

- projects: 
  - .: maven [known_with_repository_code] REPO-CODE
- hooks: 
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 0

## google/guava @ 6b3a8d7498 (4812 ms, 65 requests, scan 0% / 52 files)

- projects: 
  - .: maven [known_with_repository_code] REPO-CODE
  - android: maven [known_with_repository_code] REPO-CODE
  - guava-bom: maven [known_declarative]
  - guava-gwt: maven [known_with_repository_code] REPO-CODE
  - guava-testlib: maven [known_declarative]
  - guava-tests: maven [known_declarative]
  - guava: maven [known_declarative]
  - android/guava-bom: maven [known_declarative]
  - android/guava-testlib: maven [known_declarative]
  - android/guava-tests: maven [known_declarative]
- hooks: 
  - maven:mvnw SOURCE_BUILD risk=medium caps=REMOTE_DOWNLOAD
  - maven:mvnw.cmd SOURCE_BUILD risk=low
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:maven-dependency-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,REMOTE_DOWNLOAD
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
- entry points: 0

## apache/flink @ fed133939d (3582 ms, 11 requests, scan 0% / 0 files)

- projects: none
- hooks: none
- entry points: 0
- warnings: too_large

## apache/hadoop @ 16aa23404b (7936 ms, 75 requests, scan 0% / 64 files)

- projects: 
  - .: maven [known_with_repository_code] REPO-CODE
  - hadoop-assemblies: maven [known_declarative]
  - hadoop-build-tools: maven [known_with_repository_code] REPO-CODE
  - hadoop-client-modules: maven [known_declarative]
  - hadoop-cloud-storage-project: maven [known_declarative]
  - hadoop-common-project: maven [known_declarative]
  - hadoop-coverage: maven [known_with_repository_code] REPO-CODE
  - hadoop-dist: maven [known_with_repository_code] REPO-CODE
  - hadoop-hdfs-project: maven [known_declarative]
  - hadoop-mapreduce-project: maven [known_with_repository_code] REPO-CODE
- hooks: 
  - maven:mvnw SOURCE_BUILD risk=medium caps=REMOTE_DOWNLOAD
  - maven:mvnw.cmd SOURCE_BUILD risk=low
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:exec-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
- entry points: 0
- warnings: too_large

## jenkinsci/jenkins @ 379584d636 (7591 ms, 70 requests, scan 0% / 56 files)

- projects: 
  - .: maven [known_with_repository_code] REPO-CODE
  - bom: maven [known_with_repository_code] REPO-CODE
  - cli: maven [known_with_repository_code] REPO-CODE
  - core: maven [known_with_repository_code] REPO-CODE
  - war: maven [known_with_repository_code] REPO-CODE
  - websocket/jetty12-ee9: maven [known_with_repository_code] REPO-CODE
  - websocket/spi: maven [known_with_repository_code] REPO-CODE
- hooks: 
  - maven:frontend-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC,REMOTE_DOWNLOAD
  - maven:frontend-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC,REMOTE_DOWNLOAD
  - maven:frontend-maven-plugin SOURCE_BUILD risk=low caps=PROCESS_EXEC,REMOTE_DOWNLOAD
  - maven:antlr4-maven-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE
  - maven:maven-dependency-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,REMOTE_DOWNLOAD
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
  - maven:maven-dependency-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,REMOTE_DOWNLOAD
  - maven:maven-antrun-plugin SOURCE_BUILD risk=low caps=FILESYSTEM_WRITE,PROCESS_EXEC
- entry points: 0
- warnings: too_large

## square/okhttp @ 42e5888d45 (4833 ms, 72 requests, scan 2% / 47 files)

- projects: 
  - .: gradle [known_declarative]
  - android-test-app: gradle [known_declarative]
  - android-test: gradle [known_declarative]
  - build-logic: gradle [known_declarative]
  - maven-tests: maven [known_declarative]
  - mockwebserver-deprecated: gradle [known_declarative]
  - mockwebserver-junit4: gradle [known_declarative]
- hooks: 
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - maven:mvnw SOURCE_BUILD risk=medium caps=FILESYSTEM_DELETE,REMOTE_DOWNLOAD
  - maven:mvnw.cmd SOURCE_BUILD risk=low
  - gradle:gradlew.bat SOURCE_BUILD risk=low
- entry points: 0
- warnings: too_large

## junit-team/junit5 @ 021379b139 (3903 ms, 86 requests, scan 1% / 62 files)

- projects: 
  - .: gradle [known_declarative]
- hooks: 
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - gradle:gradlew.bat SOURCE_BUILD risk=low
- entry points: 0
- warnings: too_large

## apache/kafka @ 3de09ca097 (7132 ms, 81 requests, scan 1% / 70 files)

- projects: 
  - .: gradle [known_with_repository_code] REPO-CODE
  - api-checker: gradle [known_declarative]
  - api-checker/core: gradle [known_declarative]
  - api-checker/gradle-plugins: gradle [known_declarative]
  - api-checker/maven-plugin: gradle [known_declarative]
- hooks: 
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD,REMOTE_DOWNLOAD
  - gradle:task:genProtocolErrorDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genProtocolTypesDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genProtocolApiKeyDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genProtocolMessageDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genAdminClientConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genProducerConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genConsumerConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genKafkaConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genTopicConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genGroupConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genConsumerMetricsDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genProducerMetricsDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:processMessages SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:genStreamsConfigDocs SOURCE_BUILD risk=low caps=PROCESS_EXEC
  - gradle:task:jmh SOURCE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 0

## ktorio/ktor @ 4717dd5fe8 (3697 ms, 70 requests, scan 0% / 55 files)

- projects: 
  - .: gradle [known_declarative]
  - build-logic: gradle [known_declarative]
  - build-settings-logic: gradle [known_declarative]
  - ktor-bom: gradle [known_declarative]
  - ktor-client: gradle [known_declarative]
  - ktor-compiler-plugin: gradle [known_declarative]
- hooks: 
  - docker:Dockerfile SOURCE_BUILD risk=high caps=FILESYSTEM_DELETE,REMOTE_DOWNLOAD
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - gradle:gradlew.bat SOURCE_BUILD risk=low
- entry points: 0

## grpc/grpc-java @ 38db48ef8d (3498 ms, 66 requests, scan 3% / 54 files)

- projects: 
  - .: gradle [known_with_repository_code] REPO-CODE
  - all: gradle [known_declarative]
  - alts: gradle [known_declarative]
  - android-interop-testing: gradle [known_declarative]
  - android: gradle [known_declarative]
  - api: gradle [known_declarative]
  - auth: gradle [known_declarative]
  - authz: gradle [known_declarative]
  - autosharding: gradle [known_declarative]
- hooks: 
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - gradle:gradlew.bat SOURCE_BUILD risk=low
  - gradle:gradlew.bat SOURCE_BUILD risk=low
  - gradle:buildSrc SOURCE_BUILD risk=low
- entry points: 0

## spring-projects/spring-boot @ 535d133bda (7511 ms, 77 requests, scan 0% / 63 files)

- projects: 
  - .: gradle [known_with_repository_code] REPO-CODE
  - buildSrc: gradle [known_declarative]
  - build-plugin/spring-boot-antlib: gradle [known_declarative]
  - build-plugin/spring-boot-gradle-plugin: gradle [known_declarative]
  - build-plugin/spring-boot-maven-plugin: gradle [known_declarative]
  - buildpack/spring-boot-buildpack-platform: gradle [known_declarative]
  - cli/spring-boot-cli: gradle [known_declarative]
- hooks: 
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - gradle:gradlew.bat SOURCE_BUILD risk=low
  - gradle:buildSrc SOURCE_BUILD risk=low
- entry points: 0
- warnings: too_large

## micronaut-projects/micronaut-core @ 7a583057f8 (7369 ms, 70 requests, scan 0% / 58 files)

- projects: 
  - .: gradle [known_with_repository_code] REPO-CODE
  - aop: gradle [known_declarative]
  - buffer-netty: gradle [known_declarative]
  - buildSrc: gradle [known_declarative]
  - context-propagation: gradle [known_declarative]
  - context-python-netty: gradle [known_declarative]
  - context-python: gradle [known_declarative]
  - context: gradle [known_declarative]
- hooks: 
  - shell:setup.sh INSTALL_SCRIPT risk=high caps=DYNAMIC_CODE_LOAD,PRIVILEGE_CHANGE
  - gradle:gradlew SOURCE_BUILD risk=medium caps=DYNAMIC_CODE_LOAD
  - gradle:gradlew.bat SOURCE_BUILD risk=low
  - gradle:buildSrc SOURCE_BUILD risk=low
- entry points: 0
- warnings: too_large

