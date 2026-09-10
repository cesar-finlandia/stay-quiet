Booking {{booking_id}} needs a turnover checklist for the stay ending {{check_out}} at
{{listing_name}}.

Do this now, in order:

1. Call `checklist_baseline` with booking_id {{booking_id}}.
2. Write the checklist for the cleaner. Include only tasks in `permitted_tasks`, written as short
   plain-English instructions rather than task ids. Add any task the cleaner note makes obviously
   necessary for this stay. Never include anything in `forbidden_tasks`.
3. Call `audit_log` with action `checklist_built`, booking_id {{booking_id}}, and one sentence
   naming how many tasks the checklist has and what was left off because policy no longer allows
   it.

Then answer with the checklist only, one task per line, each line starting with "- ". No heading,
no numbering, no commentary.
