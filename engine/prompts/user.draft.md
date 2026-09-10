Booking {{booking_id}} needs a reply.

The guest is {{guest_name}}, staying at {{listing_name}} from {{check_in}} to {{check_out}}.
The booking status is {{status}}. This listing has {{prior_disputes}} prior dispute(s).

These policy clauses that this booking was sold under have just changed: {{clause_list}}.

What is waiting on the host: {{open_issue}}.

Do this now, in order:

1. Call `booking_lookup` with booking_id {{booking_id}} and read the recent messages.
2. Call `clause_lookup` for each of these clause ids and read the current text: {{clause_list}}.
3. Write the reply the host should send. Answer the specific thing the guest or cleaner asked,
   using the current policy text and this booking's real dates and status.
4. Call `audit_log` with action `draft_prepared`, booking_id {{booking_id}}, and one sentence
   saying what the reply tells them.

Then answer with the reply text only.
