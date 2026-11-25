# @scheduler/integrations-esign

E-signature of patient consents and forms (RAH-54). No vendor is chosen: only the `ESignProvider`
port and an in-memory fake exist. Forms come from the practice's approved library by form ID and
version; content is never edited or generated. Forms marked in-clinic only are never sent.
