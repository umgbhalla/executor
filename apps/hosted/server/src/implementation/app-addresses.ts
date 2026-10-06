/** Address construction and parsing share one configured suffix; forwarding headers never select an app. */
import { AppSlug, HttpUrl, type App } from "@executor-js/sdk/core";
import { UiFailed } from "apps/ui/contracts";
import { Effect, Option, Schema } from "effect";
import { AppUiAddressInvalid, AppUiHostnameLabel, type AppUiBaseUrl } from "../contracts/app-ui.ts";
import { OrganizationSlug } from "../contracts/organization.ts";

/** Hosted app.organization addresses resolve current names before authorizing immutable identities. */
export const appAddresses = (
  dashboardOrigin: string,
  baseUrl: AppUiBaseUrl | undefined,
  hostnameMode?: "single-label",
) => {
  const base = baseUrl === undefined ? undefined : new URL(baseUrl);
  const dashboardHost = new URL(dashboardOrigin).host;
  const origin = (app: Pick<App, "slug">, slug: OrganizationSlug) =>
    Effect.gen(function* () {
      if (base === undefined) return yield* new UiFailed({ reason: "unavailable" });
      const labels = yield* Schema.decodeUnknownEffect(Schema.Array(AppUiHostnameLabel))([
        app.slug,
        slug,
      ]).pipe(
        Effect.mapError(
          () =>
            new AppUiAddressInvalid({
              reason: app.slug.length > 63 || slug.length > 63 ? "too_long" : "invalid_slug",
            }),
        ),
      );
      const url = new URL(base);
      const label = `${app.slug.length.toString(36).padStart(2, "0")}-${labels.join("-")}--executor`;
      if (hostnameMode === "single-label" && label.length > 63)
        return yield* new AppUiAddressInvalid({ reason: "too_long" });
      const hostname = `${hostnameMode === "single-label" ? label : labels.join(".")}.${base.hostname}`;
      url.hostname = hostname;
      if (url.hostname !== hostname)
        return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
      if (url.hostname.length > 253) return yield* new UiFailed({ reason: "unavailable" });
      return HttpUrl.make(url.origin);
    });
  const fromHost = (host: string | undefined) => {
    if (base === undefined || host === undefined) return Option.none();
    const url = URL.parse(`${base.protocol}//${host}`);
    const suffix = `.${base.hostname}`;
    if (
      url === null ||
      url.host !== host.toLowerCase() ||
      url.port !== base.port ||
      !url.hostname.endsWith(suffix)
    )
      return Option.none();
    const prefix = url.hostname.slice(0, -suffix.length);
    const labels = (() => {
      if (hostnameMode !== "single-label") return prefix.split(".");
      if (prefix.length > 63) return [];
      const match = /^([0-9a-z]{2})-(.*)--executor$/.exec(prefix);
      if (match === null) return [];
      const length = Number.parseInt(match[1]!, 36);
      if (match[1] !== length.toString(36).padStart(2, "0")) return [];
      const names = match[2]!;
      if (names[length] !== "-") return [];
      return [names.slice(0, length), names.slice(length + 1)];
    })();
    if (labels.length !== 2) return Option.none();
    return Option.flatMap(
      Schema.decodeUnknownOption(Schema.Array(AppUiHostnameLabel))(labels),
      ([app, slug]) => {
        return Schema.decodeUnknownOption(
          Schema.Struct({
            find: Schema.Struct({ slug: AppSlug }),
            slug: OrganizationSlug,
            origin: HttpUrl,
          }),
        )({ find: { slug: app }, slug, origin: url.origin });
      },
    );
  };
  return {
    dashboardOrigin,
    enabled: base !== undefined,
    origin,
    fromHost,
    ownsHost: (host: string | undefined) =>
      base !== undefined &&
      host !== undefined &&
      host.toLowerCase() !== dashboardHost &&
      (URL.parse(`${base.protocol}//${host}`)?.hostname.endsWith(`.${base.hostname}`) ?? false),
  };
};
