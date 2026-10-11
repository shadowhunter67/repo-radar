# Execution-model probe: exec-probe-python

Analyzed commit shown per repository. Hook marked * runs for dependents when building from source. A probe, not a calibration metric.

## python-pillow/Pillow @ b01a7069e3 (6120 ms, 67 requests, scan 15% / 55 files)

- projects: 
  - .: backend [in_tree_custom] REPO-CODE native=c-extension (setuptools)
- hooks: 
  - make:Makefile SOURCE_BUILD risk=low
  - shell:install.sh INSTALL_SCRIPT risk=high caps=PRIVILEGE_CHANGE
  - make:Makefile SOURCE_BUILD risk=medium caps=FILESYSTEM_DELETE
  - pypi:pep517:backend* BUILD_BACKEND risk=low
  - pypi:setup.py* LEGACY_SETUP risk=medium caps=ENVIRONMENT_READ,PROCESS_EXEC
  - pypi:native:c-extension (setuptools)* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 0

## numpy/numpy @ 70fa99843c (5639 ms, 74 requests, scan 4% / 61 files)

- projects: 
  - .: mesonpy [known_with_repository_code] REPO-CODE native=cython+meson
- hooks: 
  - make:Makefile SOURCE_BUILD risk=medium caps=FILESYSTEM_DELETE
  - shell:setup.sh INSTALL_SCRIPT risk=medium caps=REMOTE_DOWNLOAD
  - pypi:pep517:meson-python BUILD_BACKEND risk=none
  - pypi:native:meson* NATIVE_BUILD risk=low caps=PROCESS_EXEC
  - pypi:native:cython* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 5 (e.g. f2py->numpy.f2py.f2py2e:main; numpy-config->numpy._configtool:main; pkg_config:numpy->numpy._core.lib.pkgconfig)

## pandas-dev/pandas @ 4c5953e8b3 (23999 ms, 67 requests, scan 9% / 55 files)

- projects: 
  - .: mesonpy [known_with_repository_code] REPO-CODE native=cython+meson
- hooks: 
  - pypi:pep517:meson-python BUILD_BACKEND risk=none
  - pypi:native:meson* NATIVE_BUILD risk=low caps=PROCESS_EXEC
  - pypi:native:cython* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 1 (e.g. pandas_plotting_backends:matplotlib->pandas:plotting._matplotlib)

## pyca/cryptography @ 82bb0cea49 (9449 ms, 67 requests, scan 17% / 54 files)

- projects: 
  - .: maturin [known_with_repository_code] REPO-CODE native=cffi+rust (cargo)
  - vectors: uv_build [known_declarative]
- hooks: 
  - make:Makefile SOURCE_BUILD risk=low
  - pypi:pep517:maturin BUILD_BACKEND risk=none
  - pypi:native:rust (cargo)* NATIVE_BUILD risk=low caps=PROCESS_EXEC
  - pypi:native:cffi* NATIVE_BUILD risk=low caps=PROCESS_EXEC
  - pypi:pep517:uv-build BUILD_BACKEND risk=none
- entry points: 0
- warnings: too_large

## astral-sh/ruff @ a5aee680b1 (2849 ms, 12 requests, scan 0% / 0 files)

- projects: none
- hooks: none
- entry points: 0
- warnings: too_large,too_large

## pybind/pybind11 @ 6254086d96 (3364 ms, 66 requests, scan 2% / 54 files)

- projects: 
  - .: scikit_build_core.build [known_with_repository_code] REPO-CODE native=cmake
- hooks: 
  - make:Makefile SOURCE_BUILD risk=medium caps=FILESYSTEM_DELETE
  - pypi:pep517:scikit-build-core BUILD_BACKEND risk=none
  - pypi:native:cmake* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 3 (e.g. pybind11-config->pybind11.__main__:main; pipx.run:pybind11->pybind11.__main__:main; pkg_config:pybind11->pybind11.share.pkgconfig)

## pypa/pip @ a7002c9771 (3836 ms, 61 requests, scan 10% / 49 files)

- projects: 
  - .: flit_core.buildapi [known_declarative]
- hooks: 
  - pypi:pep517:flit BUILD_BACKEND risk=none
- entry points: 2 (e.g. pip->pip._internal.cli.main:main; pip3->pip._internal.cli.main:main)

## psf/black @ 11cff1312b (3271 ms, 66 requests, scan 68% / 54 files)

- projects: 
  - .: hatchling.build [known_declarative]
- hooks: 
  - make:Makefile SOURCE_BUILD risk=low
  - docker:Dockerfile SOURCE_BUILD risk=low
  - pypi:pep517:hatchling BUILD_BACKEND risk=none
- entry points: 3 (e.g. black->black:patched_main; blackd->blackd:patched_main [d]; validate_pyproject.tool_schema:black->black.schema:get_schema)

## sqlalchemy/sqlalchemy @ 900646931b (3063 ms, 56 requests, scan 15% / 44 files)

- projects: 
  - .: setuptools.build_meta [known_with_repository_code] REPO-CODE native=c-extension (Cython/setuptools)
- hooks: 
  - pypi:pep517:setuptools BUILD_BACKEND risk=none
  - pypi:setup.py* LEGACY_SETUP risk=low caps=ENVIRONMENT_READ
  - pypi:native:c-extension (Cython/setuptools)* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 0
- warnings: too_large

## lxml/lxml @ 584df5c859 (3433 ms, 58 requests, scan 82% / 47 files)

- projects: 
  - .: setuptools.build_meta:__legacy__ [legacy_default] REPO-CODE native=c-extension (Cython/setuptools)
- hooks: 
  - make:Makefile SOURCE_BUILD risk=high caps=FILESYSTEM_DELETE,PRIVILEGE_CHANGE
  - pypi:pep517:setuptools BUILD_BACKEND risk=none
  - pypi:setup.py* LEGACY_SETUP risk=medium caps=ENVIRONMENT_READ,FILESYSTEM_WRITE,NETWORK_CLIENT,PROCESS_EXEC
  - pypi:native:c-extension (Cython/setuptools)* NATIVE_BUILD risk=low caps=PROCESS_EXEC
- entry points: 0
- warnings: too_large,too_large

## django/django @ dab0a5c47f (2578 ms, 11 requests, scan 0% / 0 files)

- projects: none
- hooks: none
- entry points: 0
- warnings: too_large

## tiangolo/fastapi @ f5c6e9b4f9 (3871 ms, 87 requests, scan 7% / 61 files)

- projects: 
  - .: pdm.backend [known_declarative]
- hooks: 
  - pypi:pep517:pdm-backend BUILD_BACKEND risk=none
- entry points: 1 (e.g. fastapi->fastapi.cli:main)

## scrapy/scrapy @ be7bdc4cd1 (2276 ms, 61 requests, scan 20% / 49 files)

- projects: 
  - .: hatchling.build [known_declarative]
- hooks: 
  - make:Makefile SOURCE_BUILD risk=low
  - pypi:pep517:hatchling BUILD_BACKEND risk=none
- entry points: 1 (e.g. scrapy->scrapy.cmdline:execute)

## pola-rs/polars @ 803d71650c (3079 ms, 82 requests, scan 2% / 69 files)

- projects: 
  - py-polars: setuptools.build_meta [known_declarative]
- hooks: 
  - make:Makefile SOURCE_BUILD risk=medium caps=FILESYSTEM_DELETE
  - make:Makefile SOURCE_BUILD risk=low
  - make:Makefile SOURCE_BUILD risk=low
  - pypi:pep517:setuptools BUILD_BACKEND risk=none
- entry points: 0
- warnings: too_large

