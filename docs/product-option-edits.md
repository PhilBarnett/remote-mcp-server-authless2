# Guarded product option edits

Staging image replacement permits hidden draft products and hidden published
products. A published staging product may change only an exact
`_wapf_fieldgroup.fields[N].options.choices[N].image` reference and its paired
attachment ID. Visible, catalog, search, private and pending staging products
remain outside this extension. Live image eligibility is unchanged.

The operation checks the expected old image before uploading, re-reads product
state and metadata before writing, then verifies the complete resulting metadata
and unchanged product identity, publication, visibility and prices. Failed writes
restore the original metadata. Originals and uploaded replacement media are retained.

The existing label-only preview/apply operation accepts an optional `choice_slug`
on each selected field. With it, `expected_label` and `new_label` refer to that
choice; without it, the existing number-field label behaviour is unchanged.
Choice IDs/slugs, images, prices, conditions, variables and calculation formulas
are preserved. Missing or duplicate targets and mismatched old labels are rejected.
Apply retains the existing whole-group hash and exact product-state checks,
complete-group read-back verification and rollback.

Curtain terminology uses **S-Wave** for the offered heading, including the
double-curtain arrangement. This is a label correction, not a change to pricing,
ordering availability or product publication.

Run `node --experimental-strip-types scripts/test-product-option-edits.mjs` for
eligibility, label preservation, actual-handler race detection and rollback tests.
