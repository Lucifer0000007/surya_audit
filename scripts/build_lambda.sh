#!/usr/bin/env bash
# Build the Lambda package without Docker, for python3.12 on x86_64 Linux.
# Run as `bash scripts/build_lambda.sh` in Git Bash; needs uv and network access to PyPI.
#
# Why not `sam build`: its pip builder resolves dependencies on this Windows machine, where
# mcp (via strands-agents) needs pywin32, which has no Linux wheel, so the build fails.
# uv resolves for the target platform instead, so Windows-only dependencies are left out.
# AWS documents building functions outside SAM and deploying the result directly:
# https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-using-build.html
# (section "Building functions outside of AWS SAM", retrieved 2026-10-08).
#
# Output: .lambda-build/ (git-ignored) holding the dependencies and the app/ package, which
# template.yaml uses as CodeUri. Then deploy with `sam deploy --template-file template.yaml ...`.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.lambda-build
rm -rf "$OUT"
mkdir -p "$OUT/app"

uv export --format requirements-txt --no-dev --no-hashes --no-emit-project --no-annotate --frozen \
  -o "$OUT/requirements.txt" > /dev/null
# The python3.12 Lambda runtime is based on Amazon Linux 2023 (https://docs.aws.amazon.com/linux/al2023/ug/lambda.html),
# which ships glibc 2.34 (https://docs.aws.amazon.com/linux/al2023/ug/core-glibc.html), so manylinux_2_28 wheels run
# there. Both retrieved 2026-10-08.
uv pip install --target "$OUT" --python-platform x86_64-manylinux_2_28 --python-version 3.12 \
  --only-binary :all: --quiet -r "$OUT/requirements.txt"
rm "$OUT/requirements.txt"

cp app/*.py app/index.html "$OUT/app/"
# Lambda: 250 MB "maximum size of the contents of a deployment package ... (unzipped)"
# (https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html, retrieved 2026-10-08).
echo "Built $OUT: $(du -sh "$OUT" | cut -f1) unzipped (Lambda allows 250 MB)."
