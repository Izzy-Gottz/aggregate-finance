# Arm A's sandbox image: Python and pandas only. Built once (`docker build -t agfn-bench-python:1 scripts/benchmark/sandbox`);
# runs never have network. The digest, Python and pandas versions are recorded in every run.json.
FROM python:3.12.7-slim-bookworm
RUN pip install --no-cache-dir pandas==2.2.3 numpy==2.1.3 && rm -rf /root/.cache
