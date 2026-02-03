ARG BUILD_FROM
FROM $BUILD_FROM

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}"

RUN \
  apk add --no-cache \
    nginx \
    jq \
  ; mkdir -p /run/nginx

COPY run.sh /run.sh
COPY www /www

EXPOSE 8099

RUN chmod +x /run.sh

CMD ["/run.sh"]
