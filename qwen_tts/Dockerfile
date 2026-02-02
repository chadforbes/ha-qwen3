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
  ; mkdir -p /run/nginx

COPY ingress.conf /etc/nginx/http.d/default.conf
COPY www /www

EXPOSE 8099

CMD ["nginx", "-g", "daemon off;"]
