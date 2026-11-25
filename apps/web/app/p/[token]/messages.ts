export type Locale = 'en' | 'es';

export interface Messages {
  pageTitle: string;
  skipToContent: string;
  languageSwitch: string;
  verifyHeading: string;
  verifyIntro: string;
  dobLabel: string;
  dobHint: string;
  verifyButton: string;
  wrongDob: (remaining: number) => string;
  unavailableHeading: string;
  unavailableExpired: string;
  unavailableUsed: string;
  unavailableLocked: string;
  unavailableInvalid: string;
  requestLinkHeading: string;
  requestLinkBody: string;
  requestLinkButton: string;
  requestLinkSent: string;
  sessionEndedNote: string;
  caseHeading: string;
  dateLabel: string;
  arrivalLabel: string;
  locationLabel: string;
  parkingLabel: string;
  surgeonLabel: string;
  phoneLabel: string;
  checklistHeading: string;
  statusDone: string;
  statusTodo: string;
  openItemsHeading: string;
  noOpenItems: string;
  contactsHeading: string;
  contactsIntro: string;
  saveContact: string;
  saved: string;
  messageTypes: Record<string, string>;
  rescheduleHeading: string;
  rescheduleIntro: string;
  rescheduleStart: string;
  rescheduleChoose: string;
  rescheduleNote: string;
  rescheduleRequested: string;
  noSlots: string;
  financialHeading: string;
  viewQuote: string;
  signConsent: string;
  payDeposit: string;
  externalLinkNote: string;
}

export const messages: Record<Locale, Messages> = {
  en: {
    pageTitle: 'Your surgery details',
    skipToContent: 'Skip to main content',
    languageSwitch: 'Español',
    verifyHeading: 'Confirm it is you',
    verifyIntro: 'To protect your privacy, enter the patient date of birth to see your surgery details.',
    dobLabel: 'Date of birth',
    dobHint: 'Use the date picker or type year-month-day, for example 1980-04-23.',
    verifyButton: 'Continue',
    wrongDob: (n) =>
      `That date of birth did not match. You have ${n} ${n === 1 ? 'try' : 'tries'} left before this link is locked.`,
    unavailableHeading: 'This link cannot be used',
    unavailableExpired: 'This link has expired.',
    unavailableUsed: 'This link was already used to open your page.',
    unavailableLocked: 'This link is locked after too many incorrect tries. Your care team has been told.',
    unavailableInvalid: 'We could not find this link.',
    requestLinkHeading: 'Get a new link',
    requestLinkBody:
      'Request a new link and we will send it to the phone number or email we have on file. You can also call your surgery location.',
    requestLinkButton: 'Request a new link',
    requestLinkSent:
      'If we can send a new link, it is on its way to the contact we have on file. Locked links are reviewed by your care team.',
    sessionEndedNote: 'For your privacy, your session ended. Request a new link to come back.',
    caseHeading: 'Your surgery',
    dateLabel: 'Surgery date',
    arrivalLabel: 'Arrival time',
    locationLabel: 'Where to go',
    parkingLabel: 'Parking',
    surgeonLabel: 'Surgeon',
    phoneLabel: 'Questions? Call',
    checklistHeading: 'Prep checklist',
    statusDone: 'Done',
    statusTodo: 'To do',
    openItemsHeading: 'What we still need from you',
    noOpenItems: 'Nothing is needed from you right now.',
    contactsHeading: 'Who gets which messages',
    contactsIntro: 'Choose the kinds of messages each person you authorized receives.',
    saveContact: 'Save choices',
    saved: 'Your choices were saved.',
    messageTypes: {
      appointment_reminders: 'Appointment reminders',
      prep_instructions: 'Prep instructions',
      forms_and_consents: 'Forms and consents',
      billing: 'Billing',
      post_op_instructions: 'After-surgery instructions',
    },
    rescheduleHeading: 'Need a different date?',
    rescheduleIntro: 'We can suggest three other dates. Your care team approves any change before it happens.',
    rescheduleStart: 'See other dates',
    rescheduleChoose: 'Ask for this date',
    rescheduleNote: 'Your current date stays until your care team confirms the change.',
    rescheduleRequested: 'Thank you. Your request was sent to your care team for approval.',
    noSlots: 'No other dates are available right now. Please call your surgery location.',
    financialHeading: 'Cost and payment',
    viewQuote: 'View your cost quote',
    signConsent: 'Sign the financial consent',
    payDeposit: 'Pay your deposit',
    externalLinkNote: 'Opens a secure page run by your practice.',
  },
  es: {
    pageTitle: 'Los detalles de su cirugía',
    skipToContent: 'Saltar al contenido principal',
    languageSwitch: 'English',
    verifyHeading: 'Confirme que es usted',
    verifyIntro: 'Para proteger su privacidad, escriba la fecha de nacimiento del paciente para ver los detalles de su cirugía.',
    dobLabel: 'Fecha de nacimiento',
    dobHint: 'Use el selector de fecha o escriba año-mes-día, por ejemplo 1980-04-23.',
    verifyButton: 'Continuar',
    wrongDob: (n) =>
      `Esa fecha de nacimiento no coincide. Le ${n === 1 ? 'queda' : 'quedan'} ${n} ${n === 1 ? 'intento' : 'intentos'} antes de que se bloquee este enlace.`,
    unavailableHeading: 'No se puede usar este enlace',
    unavailableExpired: 'Este enlace ha vencido.',
    unavailableUsed: 'Este enlace ya se usó para abrir su página.',
    unavailableLocked:
      'Este enlace está bloqueado por demasiados intentos incorrectos. Su equipo de atención ya fue avisado.',
    unavailableInvalid: 'No encontramos este enlace.',
    requestLinkHeading: 'Obtener un enlace nuevo',
    requestLinkBody:
      'Solicite un enlace nuevo y lo enviaremos al teléfono o correo que tenemos registrado. También puede llamar a su centro quirúrgico.',
    requestLinkButton: 'Solicitar un enlace nuevo',
    requestLinkSent:
      'Si podemos enviar un enlace nuevo, va en camino al contacto que tenemos registrado. Su equipo de atención revisa los enlaces bloqueados.',
    sessionEndedNote: 'Por su privacidad, su sesión terminó. Solicite un enlace nuevo para volver.',
    caseHeading: 'Su cirugía',
    dateLabel: 'Fecha de la cirugía',
    arrivalLabel: 'Hora de llegada',
    locationLabel: 'A dónde ir',
    parkingLabel: 'Estacionamiento',
    surgeonLabel: 'Cirujano',
    phoneLabel: '¿Preguntas? Llame al',
    checklistHeading: 'Lista de preparación',
    statusDone: 'Listo',
    statusTodo: 'Pendiente',
    openItemsHeading: 'Lo que aún necesitamos de usted',
    noOpenItems: 'Por ahora no necesitamos nada de usted.',
    contactsHeading: 'Quién recibe cada mensaje',
    contactsIntro: 'Elija los tipos de mensajes que recibe cada persona que usted autorizó.',
    saveContact: 'Guardar selección',
    saved: 'Se guardó su selección.',
    messageTypes: {
      appointment_reminders: 'Recordatorios de la cita',
      prep_instructions: 'Instrucciones de preparación',
      forms_and_consents: 'Formularios y consentimientos',
      billing: 'Facturación',
      post_op_instructions: 'Instrucciones después de la cirugía',
    },
    rescheduleHeading: '¿Necesita otra fecha?',
    rescheduleIntro:
      'Podemos sugerirle tres fechas distintas. Su equipo de atención aprueba cualquier cambio antes de que ocurra.',
    rescheduleStart: 'Ver otras fechas',
    rescheduleChoose: 'Pedir esta fecha',
    rescheduleNote: 'Su fecha actual se mantiene hasta que su equipo de atención confirme el cambio.',
    rescheduleRequested: 'Gracias. Su solicitud se envió a su equipo de atención para aprobación.',
    noSlots: 'Por ahora no hay otras fechas disponibles. Llame a su centro quirúrgico.',
    financialHeading: 'Costo y pago',
    viewQuote: 'Ver su presupuesto de costos',
    signConsent: 'Firmar el consentimiento financiero',
    payDeposit: 'Pagar su depósito',
    externalLinkNote: 'Abre una página segura administrada por su consultorio.',
  },
};

export function parseLocale(value: string | undefined): Locale | null {
  return value === 'en' || value === 'es' ? value : null;
}

export function formatDate(isoDate: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

export function formatTime(hhmm: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: 'UTC' }).format(
    new Date(`1970-01-01T${hhmm}:00Z`),
  );
}

export function formatDateTime(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(iso));
}
