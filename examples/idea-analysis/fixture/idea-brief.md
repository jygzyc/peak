# Offline-first field inspection assistant

Municipal inspectors currently copy paper notes into a central REST system at
the end of each shift. The idea is an Android application that captures forms,
photos and signatures while offline, detects likely omissions, and synchronizes
when connectivity returns.

Constraints:

- a three-engineer team has twelve weeks for a pilot;
- field devices can remain offline for two days;
- records contain addresses, signatures and faces;
- the existing REST API has no conflict/version protocol;
- supervisors need an audit trail and must be able to correct a record;
- the pilot success criterion is 30% less re-entry time without increasing
  missing or duplicated inspections.
