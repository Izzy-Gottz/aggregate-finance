# Arm A's sandbox image: Python and pandas only. Built once (`docker build -t agfn-bench-python:1 scripts/benchmark/sandbox`);
# runs never have network. The digest, Python and pandas versions are recorded in every run.json.
FROM python:3.12.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt && rm -rf /root/.cache /tmp/requirements.txt
