import { Suspense } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { OrganizationPage, type MemberLimit } from "@executor-js/hosted-web/pages/organization";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { Button } from "@executor-js/ui/components/button";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { DeleteOrganization } from "../components/delete-organization.tsx";
import { SsoSettings } from "../components/sso-settings.tsx";
import { BillingSettings } from "../components/billing-settings.tsx";
import { memberLimitAtom } from "../../contracts/billing.ts";
import { singleOwnerConfigurationAtom } from "../../contracts/auth.ts";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { Spinner } from "@executor-js/ui/components/spinner";

/** Members cannot read billing, and cannot invite, so they never ask for the limit. */
const noMemberLimit = Atom.make(AsyncResult.initial<{ readonly limit: number | null }>());

/** Owners and admins see the plan's member limit and an upgrade prompt when it is reached. */
function useMemberLimit(): MemberLimit | undefined {
  const organization = useOrganizationRoute();
  const administrator = organization.role === "owner" || organization.role === "admin";
  const result = useAtomValue(
    administrator ? memberLimitAtom(organization.organization) : noMemberLimit,
  );
  const confirmed = Option.getOrUndefined(AsyncResult.value(result));
  if (confirmed === undefined) return undefined;
  return {
    limit: confirmed.limit,
    upgrade: (
      <Button asChild>
        <Link
          to="/org/$organizationSlug/billing"
          params={{ organizationSlug: organization.slug }}
          search={{ organization: "", plan: "" }}
        >
          Upgrade plan
        </Link>
      </Button>
    ),
  };
}

function CloudOrganizationPage() {
  const configuration = useAtomValue(singleOwnerConfigurationAtom);
  if (AsyncResult.isFailure(configuration))
    return <p role="alert">Unable to load access settings.</p>;
  if (!AsyncResult.isSuccess(configuration)) return <Spinner />;
  if (configuration.value.enabled)
    return (
      <PageFrame>
        <PageHeader title="Owner access" />
        <p>
          This Executor is locked to one owner. Additional accounts and invitations are disabled.
        </p>
        <Button asChild variant="outline">
          <Link to="/account/security">Manage passkeys</Link>
        </Button>
      </PageFrame>
    );
  return <StandardOrganizationPage />;
}

function StandardOrganizationPage() {
  return (
    <OrganizationPage
      emailInvitations
      memberLimit={useMemberLimit()}
      footer={<DeleteOrganization />}
    >
      <BillingSettings />
      {/* Only enterprise plans show this card, and its plan check calls the billing provider;
          the rest of the page does not wait for it. */}
      <Suspense fallback={null}>
        <SsoSettings />
      </Suspense>
    </OrganizationPage>
  );
}

/** Cloud adds billing settings, the member limit and owner-only removal to the shared organization page. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  component: CloudOrganizationPage,
});
