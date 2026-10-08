/** The private product uses one DNS label so Universal SSL covers each isolated app origin. */
import { appAddresses, type AppUiBaseUrl } from "@executor-js/hosted-server/app-ui";
import {
  AppUiAddressInvalid,
  AppUiHostnameLabel,
} from "@executor-js/hosted-server/app-ui/contracts";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import { AppSlug, HttpUrl } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";

export const privateAppHostnameSuffix = "--ev2";
const ownerSlug = OrganizationSlug.make("executor");

export const cloudAppAddresses = (
  dashboardOrigin: string,
  baseUrl: AppUiBaseUrl | undefined,
  privateMode: boolean,
): ReturnType<typeof appAddresses> => {
  const shared = appAddresses(dashboardOrigin, baseUrl);
  if (!privateMode || baseUrl === undefined) return shared;
  const base = new URL(baseUrl);
  const suffix = `${privateAppHostnameSuffix}.${base.hostname}`;
  const fromHost: typeof shared.fromHost = (host) => {
    if (host === undefined || host.toLowerCase() === new URL(dashboardOrigin).host)
      return Option.none();
    const url = URL.parse(`${base.protocol}//${host}`);
    if (
      url === null ||
      url.host !== host.toLowerCase() ||
      url.port !== base.port ||
      !url.hostname.endsWith(suffix)
    )
      return Option.none();
    const app = url.hostname.slice(0, -suffix.length);
    if (!Schema.is(AppUiHostnameLabel)(`${app}${privateAppHostnameSuffix}`)) return Option.none();
    return Option.map(Schema.decodeUnknownOption(AppSlug)(app), (slug) => ({
      find: { slug },
      slug: ownerSlug,
      origin: HttpUrl.make(url.origin),
    }));
  };
  return {
    ...shared,
    origin: (app, organization) =>
      Effect.gen(function* () {
        const label = `${app.slug}${privateAppHostnameSuffix}`;
        if (organization !== ownerSlug || !Schema.is(AppUiHostnameLabel)(label))
          return yield* new AppUiAddressInvalid({
            reason: label.length > 63 ? "too_long" : "invalid_slug",
          });
        const url = new URL(base);
        url.hostname = `${label}.${base.hostname}`;
        if (url.hostname.length > 253)
          return yield* new AppUiAddressInvalid({ reason: "too_long" });
        if (url.host === new URL(dashboardOrigin).host)
          return yield* new AppUiAddressInvalid({ reason: "invalid_slug" });
        return HttpUrl.make(url.origin);
      }),
    fromHost,
    ownsHost: (host) => Option.isSome(fromHost(host)),
  };
};
