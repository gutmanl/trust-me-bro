# Stand der Technik: Prüfung LLM-generierter Literaturrecherchen

Dieses Briefing fasst den Forschungsstand zur Prüfung LLM-generierter
Rechercheergebnisse zusammen; die Fehlertaxonomie dazu steht in Abschnitt
[-@sec:grundlagen-fehlertaxonomie].

CiteTracer entscheidet 61,7 % der bibliografischen Zitationsprüfungen
deterministisch, also ohne jede LLM-Beteiligung [@citetracer2026].

Auf einem Benchmark aus 2 450 synthetischen und 957 realen fabrizierten
Zitationen erreicht CiteTracer eine Genauigkeit von 97,1 % [@citetracer2026].

Fabrizierte Referenzen weisen im Mittel mehr als zwei Fehlercodes gleichzeitig
auf, weshalb feldgenaue Prüfung der binären überlegen ist [@citetracer2026].

sciwrite-lint erkennt in einem Fehlerinjektionsexperiment 67 von 68 eingebauten
Fehlern, weist auf ungesehenen Preprints jedoch eine hohe Falsch-Positiv-Last
auf [@sciwritelint2026].

Über 14 Modelle hinweg funktionieren die Links von Deep-Research-Agenten fast
immer, die faktische Stützung ihrer Zitationen erreicht aber nur 24 % bis 77 %
[@citedbutnotverified2026].

Selbst kalibrierte LLM-Richter lassen sich für diese Prüfaufgabe statistisch
nicht voneinander unterscheiden, sodass ambige Fälle menschliche Adjudikation
erfordern [@rubricjudges2026].

Automatische Zitationsverifizierer stimmen untereinander kaum darin überein,
welche Zitationen zu beanstanden sind [@citationfaithfulness2026;
@rubricjudges2026].

CiteLab richtet sich an die Erzeugungsseite von Zitationsworkflows und nicht an
deren Prüfung [@citelab2025].

GenAudit hebt die Attributionsprüfung auf die Ebene einzelner Aussagen und
erreicht dabei 79,4 % Genauigkeit [@genaudit2024].

ClaimVer verankert die geprüften Aussagen in einem Wissensgraphen statt in
freiem Text [@claimver2024].

FACTS&EVIDENCE zerlegt einen Text in Einzelaussagen und stellt ihnen
klassifizierte Webquellen gegenüber [@factsevidence2025].

Co-FactChecker stellt die menschliche Prüferin dem Prüfmodell explizit
gegenüber, statt sie zu ersetzen [@cofactchecker2026].

ProvenanceGuard erkennt Attributionsfehler als eigene Klasse und schließt eine
Reparaturschleife daran an [@provenanceguard2026].

Co-audit beschreibt das Gegenlesen KI-erzeugter Inhalte als eigenständige
Werkzeugkategorie [@coaudit2023].

Nachvollziehbare Zusammenfassungen mit Quellenverknüpfung verbessern die
Prüfqualität, skalieren nach Angabe der Autoren aber nicht über lange Texte
[@traceabletext2024; @traceabletexts2025].

PaperTrail wurde in einer Within-Subjects-Studie mit 26 Forschenden evaluiert
und ist damit das nächste Interface-Vorbild für den eigenen Entwurf
[@papertrail2026].

DeepFact entscheidet vor der Bewertung, ob eine Aussage überhaupt prüfbar ist
[@deepfact2026].

ARIS überträgt die Prüfung auf eine adversarische Mehr-Agenten-Anordnung, bleibt
dabei aber rein beobachtend [@aris2026].

Die Claim-Level-Auditierbarkeit von Deep-Research-Agenten wird als eigenes
Forschungsproblem geführt [@aar2026].

Halluzination ist nach einem formalen Argument eine inhärente Grenze großer
Sprachmodelle und kein behebbarer Implementierungsfehler [@xu2024hallucination].

Sprachmodelle halluzinieren auch deshalb, weil gängige Trainings- und
Bewertungsverfahren Raten gegenüber Enthaltung belohnen [@kalai2025hallucinate].

Im Verfahren Mata v. Avianca sanktionierte ein US-Gericht die Einreichung
LLM-fabrizierter Fallzitate [@mata2023avianca].

Das Schneeballverfahren ist für Literaturstudien in der Softwaretechnik eine
etablierte, dokumentierte Suchstrategie [@wohlin2014].

Multivokale Literaturstudien schließen graue Literatur unter dokumentierten
Kriterien ein [@garousiMlr2019].

Das PRISMA-2020-Statement ist die maßgebliche Berichtsrichtlinie für
systematische Übersichtsarbeiten [@prisma2020].

Die Betriebskosten agentischer CLI-Werkzeuge werden vom Anbieter selbst als
steuerungsbedürftig beschrieben [@anthropiccosts2026].

Anthropic führte 2025 neue Ratenbegrenzungen für intensive Claude-Code-Nutzung
ein [@zeff2025ratelimits].
