import { createFileRoute } from "@tanstack/react-router";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { singleOwnerConfigurationAtom } from "../../contracts/auth.ts";

/** Resolve an initial destination when no usable recent-organization hint exists. */
export const Route = createFileRoute("/")({
  codeSplitGroupings: [],
  component: () => {
    const configuration = useAtomValue(singleOwnerConfigurationAtom);
    return (
      <OrganizationEntry
        allowCreate={AsyncResult.isSuccess(configuration) && !configuration.value.enabled}
      />
    );
  },
});
