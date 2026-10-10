# Contributor License Agreements

Every Plexito-de project that asks for a CLA uses these two agreements.

- [Individual agreement](INDIVIDUAL.md): you contribute as yourself. Sign it with one pull request
  comment.
- [Entity agreement](ENTITY.md): you contribute for your employer. Your employer signs it once, by
  email.

## Why a CLA

The agreement is a license, not a transfer. You keep the copyright in your contribution. You give
Plexito UG (haftungsbeschränkt) the right to distribute it as part of the project, and a patent
license for it. In return, section 2.3 limits us to the project's license on the day you submit,
or a license approved by the Open Source Initiative. We cannot relicense your contribution under
a license that is not open source.

## How the check works

A GitHub Action runs on every pull request. It looks up each commit author in the repository's
signature record, on the `cla-signatures` branch. It sets the commit status `cla` to success when
every author has signed. It does nothing else with your data. The workflow is
[cla.yml](../.github/workflows/cla.yml) and its logic is [cla.mjs](../.github/scripts/cla.mjs).
