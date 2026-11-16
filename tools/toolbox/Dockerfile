# The workbench image (src/modules/shell): everything a command may need, installed here at build time, nothing at run time (the box has no network).
# Build: npm run toolbox:build (Apple's `container build`). Debian bookworm-slim, arm64. The tag is TOOLBOX_IMAGE in src/modules/shell/box.ts.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1

# Python packages from Debian where they exist (security updates, no compiler); the two that Debian lacks come from pip below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils qpdf zip unzip jq sqlite3 qrencode libimage-exiftool-perl \
      python3 python3-pip python3-pandas python3-openpyxl python3-pypdf python3-matplotlib python3-icalendar python3-tz python3-pil tzdata \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --break-system-packages pdfplumber==0.11.10 pillow-heif==1.8.1 \
 && rm -rf /root/.cache

# No setuid binary and no sudo: a command that runs here is an ordinary user in a throwaway VM.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null; \
    useradd --uid 10001 --create-home --home-dir /home/box --shell /bin/sh box \
 && mkdir -p /work \
 && chmod 1777 /work

USER box
WORKDIR /work
