# Mautic Bounce Worker

worker for setting contacts to Do Not Contact in mautic if an email is bounced

basically completely untested

does not work with non-tamu emails since our email relay (Brevo) seems to do its
own bounce tracking and this handler does not get any emails from external
email. Perhaps augment this worker to periodically poll the Brevo API and pass
on bounced email info - although this will largely not matter since only a tiny
fraction of our contacts have non-tamu emails.
