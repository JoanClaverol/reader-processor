# Privacy Policy

_Last updated: 7 October 2026_

reader-processor is a personal, self-hosted tool. It is run by its owner for
their own Gmail account only; it is not offered as a service to anyone else.

## What it accesses

With the owner's consent (Google OAuth), the app uses two Gmail permissions:

- `gmail.modify` — to read emails carrying the owner's newsletter label and to
  add a "kindle-sent" label once something has been sent.
- `gmail.send` — to email EPUB files from the owner's own Gmail account to the
  owner's own Send-to-Kindle address.

It also downloads the public web articles that those newsletters link to, in
order to turn them into EPUBs.

## Where data is stored

Everything stays on machines the owner controls (their own computer or their
own private server):

- the Gmail OAuth token, readable only by the owner's account;
- a local SQLite cache of newsletter bodies and fetched articles, pruned after
  60 days;
- a log of what was sent to the Kindle.

## What is shared

Nothing is sold, shared, or sent to third parties. The only outgoing traffic
is to Google (the Gmail API), to Amazon (the EPUB email delivered to the
owner's Kindle address), and to the websites of the articles being fetched.
There are no analytics, ads, or trackers.

The app's use and transfer of information received from Google APIs adheres to
the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Revoking access

Access can be revoked at any time from
[Google Account → Security → Third-party connections](https://myaccount.google.com/connections),
and all local data is removed by deleting the app's `data/` directory.

## Contact

joanclaverol@gmail.com
