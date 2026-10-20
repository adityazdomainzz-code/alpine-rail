# RedPanel all-in-one image (panel + local node in "process" mode)
# For Railway and other container platforms where Docker-in-Docker is not allowed.
# Minecraft runs as plain Java processes; Java 8 / 17 / 21 / 25 are included.

FROM eclipse-temurin:8-jre-jammy AS java8
FROM eclipse-temurin:17-jre-jammy AS java17
FROM eclipse-temurin:25-jre-noble AS java25

FROM eclipse-temurin:21-jre-jammy
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=java8  /opt/java/openjdk /opt/java/8
COPY --from=java17 /opt/java/openjdk /opt/java/17
COPY --from=java25 /opt/java/openjdk /opt/java/25

WORKDIR /app
COPY node/package.json node/
RUN cd node && npm install --omit=dev --no-audit --no-fund
COPY panel/package.json panel/
RUN cd panel && npm install --omit=dev --no-audit --no-fund
COPY node/src node/src
COPY panel/src panel/src
COPY panel/public panel/public
COPY railway/start.sh /app/start.sh

ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 8000 25565
CMD ["bash", "/app/start.sh"]
