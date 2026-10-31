// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

function up(pg) {
  return pg.schema

    // parties — Every organisation seen in procurement, buyer or supplier, so one company is a
    // single row no matter how often it appears.
    .createTable('parties', table => {
      table.string('id').primary();
      table.string('source_id').unique();
      table.string('name').notNullable();
      table.string('tax_id');
      table.string('role').notNullable(); // buyer | supplier | both
      table.string('region');
      // Not unique: two parties holding one ՀՎՀՀ are reported, not refused (ticket 11).
      table.index(['tax_id'], 'parties_tax_id_idx');
    })

    // party_aliases — The per-source id of a buyer merged into another by ՀՎՀՀ (ticket 19), so
    // the next read of that source resolves to the survivor instead of re-creating the buyer the
    // merge removed.
    .createTable('party_aliases', table => {
      table.string('source_id').primary();
      table.string('party_id').notNullable().references('id').inTable('parties').onDelete('CASCADE');
      table.timestamp('merged_at').notNullable().defaultTo(pg.fn.now());
      table.index(['party_id'], 'party_aliases_party_idx');
    })

    // tenders — One row per procurement notice — the OCDS-aligned core that every downstream
    // feature reads from.
    .createTable('tenders', table => {
      table.string('id').primary();
      table.string('source_id').notNullable().unique();
      table.text('title').notNullable();
      table.text('description');
      table.string('buyer_id').notNullable().references('id').inTable('parties').onDelete('CASCADE');
      // The primary CPV code: the one the source leads with (armeps.am) or the most frequent
      // across the lots (e-auction's invitation).
      table.string('cpv_code');
      // Every CPV code the source states, the primary one included, whether or not it can be
      // put on a lot. Never NULL — "none recorded" is the empty list. GIN index in indexes().
      table.specificType('cpv_codes', 'text[]').notNullable().defaultTo('{}');
      table.string('procedure_type').notNullable();
      // How a supplier submits: eauction | armeps | paper (CHECK in indexes()). No
      // default — a source that forgets to say must fail its insert rather than file a
      // paper tender as an e-auction. Independent of procedure_type: a quotation runs
      // on ARMEPS or on paper. ADR 0004.
      table.string('submission_channel').notNullable();
      table.string('status').notNullable();
      // The source's own lifecycle label, verbatim. eauction publishes ten
      // states (Նախաաճուրդային, Աճուրդ, Շնորհում, …) which collapse into the
      // six-value `status` enum; this keeps the distinction queryable instead
      // of showing a supplier "closed" for six different situations.
      table.string('source_status');
      table.decimal('estimated_value', 18, 2);
      table.string('reference_code');
      table.index(['reference_code'], 'tenders_reference_code_idx');
      table.string('goods_works_services');   // Ապրանք | Աշխատանք | Ծառայություն
      // How the winner is chosen (lowest_price, …), as armeps.am states it. NULL for
      // e-auctions, whose pages state none.
      table.string('evaluation_method');
      // Where a paper bid is delivered, as the invitation states it. NULL for e-auction and
      // ARMEPS tenders, which are bid online.
      table.text('submission_address');
      table.timestamp('auction_at');
      table.string('invitation_url');
      table.string('currency').notNullable().defaultTo('AMD');
      table.timestamp('published_at');
      table.timestamp('deadline_at');
      table.timestamp('qna_deadline_at');
      table.integer('version').notNullable().defaultTo(1);
      table.boolean('is_latest').notNullable().defaultTo(true);
      table.index(['buyer_id'], 'tenders_buyer_idx');
      table.index(['submission_channel'], 'tenders_submission_channel_idx');
    })

    // tender_sources — Every source a tender came from, one row per link (ADR 0004). A tender
    // is one run assembled from several sites, and `tenders.source_id` names only the one that
    // created it. UNIQUE (source, external_id) is the dedupe anchor: re-seeing a link is an
    // update, and a concurrent insert that loses the race is success, as for source_payloads.
    // Public data: no organization_id.
    .createTable('tender_sources', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('source').notNullable();
      table.string('external_id').notNullable();    // eauction tid, armeps.am resourceId, gnumner URL, …
      table.text('url');
      table.string('role').notNullable();           // discovery | detail | results (CHECK in indexes())
      table.string('observed_status');              // what this source last said, verbatim — or `superseded`, sticky (ticket 29)
      table.string('points_to');                    // a discovery link: `{source}:{external id}` of the link it is a notice of (ticket 07)
      // A gnumner failed-procedure notice's link: the lots it declared failed (ticket 09). NULL on
      // every other link. The tender is cancelled only once its notices name every lot it has.
      table.specificType('failed_lots', 'integer[]');
      table.timestamp('first_seen_at').notNullable().defaultTo(pg.fn.now());
      table.timestamp('last_seen_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['source', 'external_id'], { indexName: 'tender_sources_source_external_uq' });
      table.index(['tender_id'], 'tender_sources_tender_idx');
    })

    // unmatched_results — A result row from a source that could not be attached to exactly one
    // tender (ADR 0004): kept with its reason and counted, never guessed onto a tender. Unique on
    // (source, external_ref), so a re-seen result updates its row rather than adding one. The
    // reader is the operator alert. Public data: no organization_id.
    .createTable('unmatched_results', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('external_ref').notNullable();
      table.string('procedure_code');
      table.string('reason').notNullable();         // no_candidate | ambiguous | no_code | unsupported_format
      // The procedure, as far as the result says (`single_source`, `quotation`, …): the unreadable
      // count is split on it (ticket 31).
      table.string('procedure_type');
      // A result's procedure was announced publicly: true (so a `no_candidate` is a tender Tendra
      // missed — the operator alert's row), false (never public), NULL (not known). Ticket 31.
      table.boolean('was_public');
      table.specificType('candidate_tender_ids', 'text[]').notNullable().defaultTo('{}');
      table.string('payload_hash').notNullable();   // the stored raw payload it was read from
      table.timestamp('first_seen_at').notNullable().defaultTo(pg.fn.now());
      table.timestamp('last_seen_at').notNullable().defaultTo(pg.fn.now());
      table.string('resolved_tender_id').references('id').inTable('tenders').onDelete('SET NULL');
      table.timestamp('resolved_at');
      table.unique(['source', 'external_ref'], { indexName: 'unmatched_results_source_ref_uq' });
    })

    // listing_notices — Every notice gnumner's invitation listings have shown, with the code its
    // title names and when it was published (ticket 31): what "no invitation of this code was ever
    // seen" is asked of, since a notice whose job failed or whose file was unreadable leaves no
    // tender behind. `external_id` is the notice's discovery-link id (`paper:{digest}`,
    // `armeps:{resourceId}`), so a notice whose title has no code finds its tender's through
    // `tender_sources`. Also gnumner's e-auction listing (ticket 34), a coverage count only, under
    // ids of its own (`listing:eauction:eauction:{tmid}`). Written by the listing chain. Public
    // data: no organization_id.
    .createTable('listing_notices', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('external_id').notNullable();
      table.string('listing').notNullable();        // the listing's slug: open | quotation | eauction
      table.string('procedure_code');               // the title's, raw; NULL when it names none
      table.timestamp('published_at').notNullable();
      table.timestamp('first_seen_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['source', 'external_id'], { indexName: 'listing_notices_source_external_uq' });
    })

    // awards — The winner of each individual lot, with the price it won at alongside the
    // buyer's budget for that lot.
    .createTable('awards', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.integer('lot_number');
      table.string('supplier_id').references('id').inTable('parties').onDelete('SET NULL');
      table.decimal('amount', 18, 2);               // with VAT — what the buyer pays; compare to estimated_value
      table.decimal('net_amount', 18, 2);           // without VAT — what won the auction; compare to other bids
      table.decimal('estimated_value', 18, 2);
      table.string('currency').notNullable().defaultTo('AMD');
      table.timestamp('awarded_at');
      table.string('status').notNullable();
      table.string('source').notNullable().defaultTo('eauction');
      table.unique(['tender_id', 'lot_number', 'source'], { indexName: 'awards_tender_lot_source_uq' });
      table.unique(['id', 'tender_id'], { indexName: 'awards_id_tender_uq' });
      table.index(['supplier_id'], 'awards_supplier_idx');
    })

    // public_tender_bids — Every competing bid on a finished tender, losers included — the
    // comparables corpus for benchmarks and competitor analysis, distinct from `bids` which is
    // a customer's own private bid.
    .createTable('public_tender_bids', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.integer('lot_number').notNullable();
      table.string('supplier_id').references('id').inTable('parties').onDelete('SET NULL');
      table.integer('rank');                        // "Զբաղեցրած տեղ" — 1 = lot winner
      // Two prices per offer, because they answer different questions. The budget includes
      // VAT and is checked against `*_price`; the auction ranks on `*_net`. Comparing a VAT
      // payer's `_price` with a non-payer's puts the winner 20% above a bidder it beat.
      table.decimal('budget_price', 18, 2);         // "Նախահաշվային գին", with VAT
      table.decimal('initial_offer_price', 18, 2);  // "Նախնական առաջարկ — Գին", with VAT
      table.decimal('initial_offer_net', 18, 2);    // the same offer's value cell, without VAT
      table.decimal('final_offer_price', 18, 2);    // "Վերջին առաջարկ — Գին", with VAT
      table.decimal('final_offer_net', 18, 2);      // the same offer's value cell, without VAT — what ranks
      table.float('vat_pct');
      table.string('status').notNullable(); // 'accepted' | 'rejected', mapped from "Մասնակցի կարգավիճակ"
      table.string('application_url');
      table.string('currency').notNullable().defaultTo('AMD');
      table.string('source').notNullable().defaultTo('eauction');
      table.timestamp('fetched_at').notNullable();
      table.unique(['tender_id', 'lot_number', 'supplier_id', 'source'], {
        indexName: 'public_tender_bids_tender_lot_supplier_source_uq',
      });
      table.index(['tender_id'], 'public_tender_bids_tender_idx');
      table.index(['supplier_id'], 'public_tender_bids_supplier_idx');
      table.index(['tender_id', 'lot_number', 'rank'], 'public_tender_bids_tender_lot_rank_idx');
    })

    // tender_lots — The separately-biddable slices of a tender, each with its own CPV code and
    // item text, because one tender routinely spans many categories.
    .createTable('tender_lots', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.integer('lot_number').notNullable();
      table.string('cpv_code');
      // A row is one ITEM, not one lot. The invitation's Ծածկագիր cell reads
      // "45000000/2" — code then item sequence — so a lot routinely carries
      // several, and keying on (tender, lot) alone threw 23505 on every
      // multi-item lot, aborting applyInvitationFacts and taking the CPV, the
      // buyer tax ID and the document row down with it.
      table.integer('item_sequence').notNullable();
      table.text('name');
      // `source` is in the key for the same reason as awards: the replace is
      // scoped by source, so a second writer's row must not collide with the
      // first's. Both key columns are NOT NULL because a NULL never collides in
      // a Postgres unique index, which would silently reopen the duplicate.
      table.string('source').notNullable().defaultTo('eauction');
      table.unique(['tender_id', 'lot_number', 'item_sequence', 'source'], {
        indexName: 'tender_lots_tender_lot_item_source_uq',
      });
      table.index(['cpv_code'], 'tender_lots_cpv_idx');
    })

    // contracts — Signed contract values following a procurement; deliberately empty until
    // post-award tracking is built (phase 6).
    .createTable('contracts', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      // Nullable, and carrying NO single-column FK of its own: it is half of the composite
      // key in indexes(), and an independent FK beside that key is what lets the two
      // disagree about which award belongs to which tender.
      table.string('award_id');
      table.decimal('value', 18, 2);
      table.timestamp('signed_at');
      table.string('status').notNullable();
    })

    // tender_documents — A pointer to each file published with a tender, since the file itself
    // lives in object storage rather than the database.
    .createTable('tender_documents', table => {
      table.string('id').primary();
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('url').notNullable();
      table.string('storage_key').notNullable();
      table.string('kind').notNullable();
      table.boolean('parsed').notNullable().defaultTo(false);
      // The files inside the stored archive, listed once at ingest so a tender page never
      // reads the archive to show them. NULL means not listed yet, never "no files".
      table.jsonb('manifest');
      // A tender holds one row per document set it was ever issued (an addendum is a new
      // set), and the newest is the one it holds now.
      table.timestamp('stored_at').notNullable().defaultTo(pg.fn.now());
      // Hash of the extracted text stored beside the archive, the same hash a checklist
      // records in checklists.document_hash — comparing the two says whether a checklist's
      // AI items come from this document without reading the text. NULL: no text stored.
      table.string('text_hash');
      // Lets the database arbitrate the concurrent-insert race instead of a
      // read-then-insert, which two jobs can both pass. Same principle as
      // source_payloads.
      table.unique(['tender_id', 'storage_key'], { indexName: 'tender_documents_tender_key_uq' });
    })

    // source_payloads — The fetch ledger — what was retrieved, when, and where its raw copy
    // sits — which is what makes ingestion idempotent and re-parseable without re-crawling.
    .createTable('source_payloads', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('ref').notNullable();
      table.string('storage_key').notNullable();
      table.string('hash').notNullable();
      table.timestamp('fetched_at').notNullable();
      table.unique(['source', 'ref', 'hash'], {
        indexName: 'source_payloads_source_ref_hash_uq',
      });
    })

    // users — A person who can sign in; identity only, with access to any organisation granted
    // through memberships.
    .createTable('users', table => {
      table.string('id').primary();
      table.string('email').notNullable().unique();
      table.string('password_hash').notNullable();
      table.string('display_name').notNullable();
      table.string('locale').notNullable().defaultTo('hy');
      table.timestamp('email_verified_at');
      // A person running Tendra itself (CONTEXT.md, Operator), never a role in an organization.
      // Set by hand, never through the API; read at session mint and refresh like the role and
      // carried as the `op` claim, so clearing it lands within one access-token lifetime.
      table.boolean('is_operator').notNullable().defaultTo(false);
    })

    // organizations — A supplier company using Tendra, and the tenant boundary that every
    // private table is scoped by.
    .createTable('organizations', table => {
      table.string('id').primary();
      table.string('name').notNullable();
      // The organization's Fields: ids from src/libs/fields.js, at most three (CHECK in
      // indexes()). An array like saved_searches.cpv_codes, and never NULL — "no field
      // claimed" is the empty list, so readers have one shape to handle.
      table.specificType('type', 'text[]').notNullable().defaultTo('{}');
      table.string('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    })

    // supplier_identities — The parties this tenant bids AS. `awards` and `public_tender_bids`
    // identify a bidder by parties.id, so without a claim there is no way to ask "did we win
    // this". A set (ticket 32): a paper bidder is keyed by its name and an e-auction bidder by
    // its operator id, so one company is several parties until a ՀՎՀՀ joins them, and each is
    // a separate human claim from a search — never matched on name. Replaced
    // organizations.supplier_party_id.
    .createTable('supplier_identities', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('party_id').notNullable().references('id').inTable('parties').onDelete('CASCADE');
      table.string('claimed_by').references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('claimed_at').notNullable().defaultTo(pg.fn.now());
      // One organization per party, as the single claim was: two orgs claiming one party
      // would each resolve an outcome from the same ledger rows, and one of them would be wrong.
      table.unique(['party_id'], { indexName: 'supplier_identities_party_uq' });
      table.index(['organization_id'], 'supplier_identities_org_idx');
    })

    // roles — Named permission sets (owner, admin, coordinator, viewer, consultant) that
    // memberships assign.
    //
    // The id IS the role's name rather than a CUID, because the one-owner index below needs a
    // literal in its predicate and a partial index cannot look one up. A separate `name` column
    // would then be the same string twice — a second answer to "which role is this" that can
    // disagree with the first. ADR 0002.
    .createTable('roles', table => {
      table.string('id').primary();
    })

    // permissions — One row per fine-grained capability string ('tender:read', 'bid:write').
    // A real table rather than a text[] on roles, so a permission is a thing the schema knows
    // about: joinable, countable, and impossible to grant under a name that does not exist.
    .createTable('permissions', table => {
      table.string('id').primary();
      table.string('key').notNullable().unique();
    })

    // role_permissions — Which capabilities each role carries. The unique key is what makes
    // re-seeding idempotent; both sides cascade, so dropping a role or a permission cannot
    // strand a grant behind it.
    .createTable('role_permissions', table => {
      table.string('id').primary();
      table.string('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
      table.string('permission_id').notNullable().references('id').inTable('permissions').onDelete('CASCADE');
      table.unique(['role_id', 'permission_id'], { indexName: 'role_permissions_role_permission_uq' });
    })

    // memberships — Which user belongs to which organisation, and in what role.
    .createTable('memberships', table => {
      table.string('id').primary();
      table.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('role_id').notNullable().references('id').inTable('roles').onDelete('RESTRICT');
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['user_id', 'organization_id']);
    })

    // invitations — A standing offer for an email address to join an organisation at a role.
    //
    // Keyed on the address, not a user: the row survives an address with no account and is
    // matched when that address registers and verifies. No expiry column — no credential
    // travels in an email, so there is nothing to age out. UNIQUE (organization_id, email)
    // makes a repeat invite an in-place update the database arbitrates, not a second offer.
    .createTable('invitations', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('email').notNullable();
      table.string('role_id').notNullable().references('id').inTable('roles').onDelete('RESTRICT');
      table.string('status').notNullable().defaultTo('pending');
      table.string('invited_by').references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('responded_at');
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['organization_id', 'email'], { indexName: 'invitations_org_email_uq' });
    })

    // tracked_tenders — A tender an organisation has decided to pursue, and the anchor every
    // bid-workflow table hangs off.
    .createTable('tracked_tenders', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('tender_id').notNullable().references('id').inTable('tenders').onDelete('CASCADE');
      table.string('status').notNullable();
      table.string('go_no_go');
      table.text('decision_note');
      // What the relevant list showed when this was tracked from it: the score, and the band,
      // reasons and moment as shown. Written once on insert, never recomputed — a recomputed
      // score would describe a ranking nobody saw. Both NULL when tracked from elsewhere.
      table.decimal('relevance_score', 5, 4);
      table.jsonb('relevance_shown');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
      table.unique(['organization_id', 'tender_id']);
      table.unique(['id', 'organization_id'], { indexName: 'tracked_tenders_id_org_uq' });
    })

    // bids — An organisation's own bid on a tracked tender, locked into a read-only snapshot
    // once submitted.
    .createTable('bids', table => {
      table.string('id').primary();
      // No single-column FK on tracked_tender_id: the composite one added in indexes() covers
      // it, and carrying both would mean two cascade paths for one relationship.
      table.string('tracked_tender_id').notNullable().unique();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.decimal('price', 18, 2);                // without VAT — the auction value entered
      table.integer('lot_number');
      table.string('currency').notNullable().defaultTo('AMD');
      table.text('notes');
      table.timestamp('submitted_at');
      table.boolean('locked').notNullable().defaultTo(false);
      // 'won' | 'lost' | 'not_found', resolved against the public bid ledger once the tender
      // settles. 'not_found' is a real answer, not an error — the ledger may simply not be published yet.
      table.string('outcome');
      table.timestamp('outcome_resolved_at');
      // Copied, not joined: public_tender_bids is replaced wholesale on re-normalize, so a
      // stored "we lost by 4%" must not move because a parser improved later. Without VAT,
      // like `price`, so the gap compares like with like.
      table.decimal('winning_price', 18, 2);
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // checklists — Per-tracked-tender container for the requirements a bid has to satisfy.
    .createTable('checklists', table => {
      table.string('id').primary();
      // No single-column FK: the composite one in indexes() covers it and anchors organization_id.
      table.string('tracked_tender_id').notNullable().unique();
      table.string('organization_id').notNullable();
      table.string('status').notNullable().defaultTo('pending'); // pending | ready | unavailable | failed
      table.string('source').notNullable().defaultTo('ai');
      // Provenance. "The AI said so" is not auditable — when an extraction turns out to be
      // wrong the first question is which model wrote it, and from which document.
      table.string('model');
      table.timestamp('generated_at');
      // Content hash of the invitation text. The idempotency anchor: re-extracting an
      // unchanged document is a no-op, an amended one earns a genuine re-read.
      table.string('document_hash');
      table.string('failure_reason');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // checklist_items — A single bid requirement, AI-extracted or manual, carrying a
    // confidence score so low-confidence ones can route to human review.
    .createTable('checklist_items', table => {
      table.string('id').primary();
      // No single-column FK: see checklists above.
      table.string('checklist_id').notNullable();
      table.string('organization_id').notNullable();
      table.string('label').notNullable();
      table.string('category'); // eligibility | financial | technical | document | procedural
      table.boolean('required').notNullable().defaultTo(true);
      table.float('confidence');
      // The verbatim span from the invitation that established this requirement. What makes
      // an extracted item checkable rather than an assertion; null for a manual item, which
      // has no source document to quote.
      table.text('evidence');
      // Stored, not derived: the threshold is configurable, and recomputing on read would
      // re-open items a human already cleared whenever the config moved.
      table.boolean('needs_review').notNullable().defaultTo(false);
      table.string('source').notNullable().defaultTo('ai'); // ai | manual
      table.integer('sort_order').notNullable().defaultTo(0);
      table.boolean('done').notNullable().defaultTo(false);
      // Which vault document satisfies this requirement. The enforcement site for BR-12
      // — an expired certificate cannot be attached — since the checklist is where a
      // requirement and a held document actually meet. Composite FK in indexes().
      table.string('vault_document_id');
      table.timestamp('attached_at');
      table.timestamp('reviewed_at');
      table.timestamp('created_at').defaultTo(pg.fn.now());
    })

    // vault_documents — An organisation's reusable certificates and licences, with expiry
    // tracked so an expired one can never be attached to a bid.
    .createTable('vault_documents', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      // Free text, not an enum, and deliberately so: the set of certificates a buyer can
      // demand is defined by the tender, not by us. src/features/vault owns a suggested
      // vocabulary for the UI; the column accepts whatever a customer actually holds.
      table.string('kind').notNullable();
      table.string('storage_key').notNullable();
      table.timestamp('valid_until');
      // sha256 of the bytes. Both the dedupe key and the tail of the storage key, so a
      // document is content-addressed and a re-upload is an overwrite, not a duplicate.
      table.string('hash').notNullable();
      // The upload is register -> PUT to storage -> confirm, so a row exists before its
      // bytes do. Without this, an abandoned upload is indistinguishable from a real
      // document and the vault lists files nobody can download.
      table.string('status').notNullable().defaultTo('pending'); // pending | ready | rejected
      table.string('filename');
      table.string('content_type');
      table.bigInteger('size_bytes');
      table.timestamp('issued_at');
      table.text('notes');
      table.string('uploaded_by_user_id').references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // saved_searches — A stored discovery profile that newly ingested tenders are matched
    // against to raise alerts.
    .createTable('saved_searches', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      // What the profile is called in a list. NOT NULL because the alternative is telling
      // profiles apart by reading their CPV arrays. Not unique: it is a label, not an identifier.
      table.string('name', 100).notNullable();
      table.specificType('cpv_codes', 'text[]').notNullable().defaultTo('{}');
      table.specificType('keywords', 'text[]').notNullable().defaultTo('{}');
      table.specificType('regions', 'text[]').notNullable().defaultTo('{}');
      table.decimal('min_value', 18, 2);
      table.decimal('max_value', 18, 2);
      table.specificType('channels', 'text[]').notNullable().defaultTo('{}');
      table.timestamp('created_at').defaultTo(pg.fn.now());
      table.timestamp('updated_at').defaultTo(pg.fn.now());
    })

    // price_benchmarks — Precomputed price statistics per CPV so intelligence reads stay fast
    // and are never calculated live.
    .createTable('price_benchmarks', table => {
      // CUIDs are generated by the application, as with the existing tables.
      table.string('id').primary();
      table.string('cpv_code').notNullable();
      table.string('buyer_id').references('id').inTable('parties').onDelete('SET NULL');
      table.integer('sample_size').notNullable();
      // How many distinct TENDERS those awards came from. sample_size counts
      // awards and awards are per lot, so one multi-lot procurement can clear
      // the comparables threshold alone — this is what separates "33 awards
      // across 33 buys" from "33 lots of one buy".
      table.integer('distinct_tenders');
      table.decimal('min_price', 18, 2);
      table.decimal('median_price', 18, 2);
      table.decimal('max_price', 18, 2);
      // decimal, not float: a percentage stored as float4 reads back with
      // seven digits of single-precision noise (6.8833737 for 6.88).
      table.decimal('avg_discount_pct', 6, 2);
      // Awards with a budget that avg_discount_pct left out because their contract is not the
      // winning offer (a PPCM framework or partial contract): counted, never given a guessed gross.
      // NULL on a row computed before the count was kept.
      table.integer('discount_excluded');
      table.timestamp('computed_at').notNullable();
      // Deliberately not unique: a NULL never collides in a Postgres unique
      // index, so a unique constraint would silently permit duplicate global
      // (buyer-less) rows. The repository arbitrates; this only makes the
      // per-request lookup cheap once buyer-specific rows multiply the table.
      table.index(['cpv_code', 'buyer_id'], 'price_benchmarks_cpv_buyer_idx');
    })

    // buyer_profiles — Aggregated behaviour of a buying agency — spend, volume, and which
    // suppliers keep winning its tenders.
    .createTable('buyer_profiles', table => {
      table.string('id').primary();
      table.string('buyer_id').notNullable().unique().references('id').inTable('parties').onDelete('CASCADE');
      table.decimal('total_spend', 18, 2);
      table.integer('tender_count').notNullable();
      table.specificType('favored_supplier_ids', 'text[]').notNullable();
    })

    // supplier_profiles — Aggregated behaviour of a competitor — win rate, categories bid on,
    // and typical discount.
    .createTable('supplier_profiles', table => {
      table.string('id').primary();
      table.string('supplier_id').notNullable().unique().references('id').inTable('parties').onDelete('CASCADE');
      table.float('win_rate');
      table.specificType('categories', 'text[]').notNullable();
      // decimal, not float: a percentage stored as float4 reads back with
      // seven digits of single-precision noise (6.8833737 for 6.88).
      table.decimal('avg_discount_pct', 6, 2);
    })

    // notifications — One alert raised for a user, recorded independently of how or whether it
    // was delivered.
    .createTable('notifications', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('user_id').references('id').inTable('users').onDelete('SET NULL');
      table.string('type').notNullable(); // tender-match, amendment, reminder, expiry
      table.string('tender_id').references('id').inTable('tenders').onDelete('SET NULL');
      // What the notification is about when it is not about a tender. BR-9 dedupes on
      // (organization_id, type, tender_id); a vault expiry has no tender, so without this
      // every expiring document in an org would collapse into one alert and only the
      // first certificate would ever be reported. NULL for anything tender-shaped.
      table.string('subject_id');
      table.jsonb('payload').notNullable();
      table.timestamp('read_at');
      // Ordering column. CUID2 is deliberately not sortable, so `order by id`
      // is arbitrary — an alert feed has to be chronological, and the cursor
      // rule needs a stable sort key with an id tiebreaker.
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.index(['organization_id', 'created_at'], 'notifications_org_created_idx');
    })

    // channel_subscriptions — Where an org's alerts actually go, and the ONLY
    // switch that decides whether a channel is on for an organization at all: a
    // channel with no live row here simply is not delivered to, which is why
    // there is no `alert_channels` column anywhere. A Telegram bot cannot open a
    // conversation, so a chat has to be linked by the user messaging the bot
    // first; that gives a subscription a lifecycle (pending → verified →
    // revoked) which a column on `organizations` has nowhere to hold.
    .createTable('channel_subscriptions', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      /**
       * CASCADE, not SET NULL. The SET NULL this replaced existed so an
       * organization kept a shared Telegram room when the person who set it up
       * left — but only a PRIVATE chat can be linked now, so there are no
       * shared rooms and every row is one person's own destination. Nulling the
       * owner would leave an orphan chat still receiving the org's alerts with
       * nobody it can be governed by and no one to revoke it.
       */
      table.string('user_id').references('id').inTable('users').onDelete('CASCADE');
      table.string('channel').notNullable(); // telegram | email 
      // Null until confirmed — for Telegram the chat id is not knowable until
      // the user messages the bot.
      table.string('address');
      table.string('link_token');
      table.timestamp('token_expires_at');
      table.timestamp('verified_at');
      table.timestamp('revoked_at');
      table.integer('failure_count').notNullable().defaultTo(0);
      table.text('last_error');
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(pg.fn.now());
      table.index(['organization_id', 'channel'], 'channel_subscriptions_org_channel_idx');
      table.index(['channel', 'address'], 'channel_subscriptions_channel_address_idx');
    })

    // alert_deliveries — The per-channel delivery attempt and outcome for a notification.
    .createTable('alert_deliveries', table => {
      table.string('id').primary();
      table.string('notification_id').notNullable().references('id').inTable('notifications').onDelete('CASCADE');
      table.string('channel').notNullable();
      table.string('status').notNullable();
      table.timestamp('sent_at');
      // Quiet hours defer a delivery rather than dropping it, so a waiting
      // alert must be distinguishable from a failed one.
      table.timestamp('deferred_until');
      table.text('detail');
    })

    // plans — The subscription tiers on offer and the features each one entitles.
    .createTable('plans', table => {
      table.string('id').primary();
      table.string('name').notNullable();
      table.decimal('price_usd', 18, 2).notNullable();
      table.specificType('features', 'text[]').notNullable();
    })

    // promo_codes — A code an operator issues and an owner redeems for a period of a plan.
    //
    // `code` is stored upper-cased and trimmed (CHECK in indexes()), so a lookup is an equality
    // and a code typed off a flyer matches whatever its case. `plan_id` never names `free`, which
    // the boundary refuses: plans are keyed by CUID, so no CHECK can. `max_redemptions` NULL is
    // unlimited, and `redemption_count` is moved by a conditional UPDATE so the database holds
    // the limit under concurrent redemptions. A redeemed code is disabled, never deleted — the
    // periods it granted keep their record of where they came from.
    .createTable('promo_codes', table => {
      table.string('id').primary();
      table.string('code').notNullable();
      table.string('plan_id').notNullable().references('id').inTable('plans').onDelete('RESTRICT');
      table.integer('percent_off').notNullable();
      table.integer('duration_months').notNullable();
      table.integer('max_redemptions');
      table.integer('redemption_count').notNullable().defaultTo(0);
      table.timestamp('redeemable_until');
      table.timestamp('disabled_at');
      table.string('created_by').references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['code'], { indexName: 'promo_codes_code_uq' });
    })

    // subscriptions — One period during which an organisation holds one plan (ADR 0005). An
    // organisation accumulates them — a trial, then promo periods, then paid ones — and its plan
    // is the non-voided row covering now, else free. Current or lapsed is read from the dates;
    // there is no status, because a stored one needs a sweep to flip it, and a missed sweep
    // leaves an organisation on Pro forever. No overlap: subscriptions_no_overlap_excl.
    .createTable('subscriptions', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.string('plan_id').notNullable().references('id').inTable('plans').onDelete('RESTRICT');
      table.string('kind').notNullable(); // trial | promo | paid
      // Half-open: a period starting the moment another ends follows it, never overlaps it.
      table.timestamp('period_start').notNullable();
      table.timestamp('period_end').notNullable();
      // The code a promo period was redeemed with. RESTRICT: a redeemed code is disabled, never
      // deleted, and this is the database holding that.
      table.string('promo_code_id').references('id').inTable('promo_codes').onDelete('RESTRICT');
      // A trial copies its organisation's created_by here, so one trial per creator can be an
      // index rather than a join: subscriptions_trial_creator_uq.
      table.string('trial_creator_id').references('id').inTable('users').onDelete('SET NULL');
      // Voiding is what an operator does to a grant made in error. A voided row grants nothing
      // and is left out of the overlap rule, but stays as the record that it was granted.
      table.timestamp('voided_at');
      table.string('voided_by').references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('created_at').notNullable().defaultTo(pg.fn.now());
      table.index(['organization_id', 'period_start'], 'subscriptions_org_start_idx');
    })

    // invoices — Billing history per organisation.
    .createTable('invoices', table => {
      table.string('id').primary();
      table.string('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
      table.decimal('amount', 18, 2).notNullable();
      table.string('status').notNullable();
      table.timestamp('issued_at').notNullable();
    })

    // audit_logs — Immutable record of who did what to which entity, for security review and
    // compliance.
    .createTable('audit_logs', table => {
      table.string('id').primary();
      table.string('organization_id').references('id').inTable('organizations').onDelete('SET NULL');
      table.string('actor_user_id').references('id').inTable('users').onDelete('SET NULL');
      table.string('action').notNullable();
      table.string('entity').notNullable();
      table.string('entity_id');
      table.jsonb('metadata').notNullable();
      table.timestamp('at').notNullable().defaultTo(pg.fn.now());
    });
}

/**
 * Partial unique indexes, which Knex's schema builder cannot express.
 *
 * Both need a WHERE clause to be correct rather than merely present:
 * `address` is NULL while a link is pending and a NULL never collides in a
 * Postgres unique index, so an unfiltered constraint would permit two confirmed
 * duplicates of the same chat while appearing to forbid them.
 */
async function indexes(pg) {
  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS channel_subscriptions_live_uq
     ON channel_subscriptions (organization_id, channel, address)
     WHERE address IS NOT NULL AND revoked_at IS NULL`);
  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS channel_subscriptions_token_uq
     ON channel_subscriptions (link_token) WHERE link_token IS NOT NULL`);

  /**
   * Exactly one owner per organization — not "at least one".
   *
   * Counting owners in the service before promoting someone is check-then-act: two concurrent
   * promotions both count one, both pass, and the organization keeps two owners silently and
   * permanently. So the database arbitrates the *two* side, the same division of labour as
   * `source_payloads` and `notifications_dedupe_uq`; the service still guards the *zero* side,
   * which no constraint can express. ADR 0002.
   *
   * The predicate is a literal, which is why `roles.id` is the role's own name. It also means
   * transfer-of-ownership must demote the caller BEFORE promoting the target — a unique index
   * cannot be deferred, so the reverse order rejects the hand-off.
   */
  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_uq
     ON memberships (organization_id) WHERE role_id = 'owner'`);

  /**
   * Invitations: the three rules that must hold whatever the service does.
   *
   * Never at `owner` — there is one owner seat and it moves by transfer, so an offer of it is
   * unrepresentable rather than merely refused (ADR 0002). Lowercased email, so "offers
   * addressed to me" is an equality and `Gevorg@` and `gevorg@` cannot be two offers. The
   * email index serves that lookup, which spans every organisation.
   */
  await pg.raw(`ALTER TABLE invitations ADD CONSTRAINT invitations_status_chk
     CHECK (status IN ('pending','accepted','declined'))`);
  await pg.raw(`ALTER TABLE invitations ADD CONSTRAINT invitations_not_owner_chk
     CHECK (role_id <> 'owner')`);
  await pg.raw(`ALTER TABLE invitations ADD CONSTRAINT invitations_email_lower_chk
     CHECK (email = lower(email))`);
  await pg.raw(`CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (email)`);

  // Promo codes: the normalized text is the identity, and the limit can never be passed.
  await pg.raw(`ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_chk
     CHECK (code = upper(btrim(code)) AND code <> '')`);
  await pg.raw(`ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_percent_off_chk
     CHECK (percent_off BETWEEN 1 AND 100)`);
  await pg.raw(`ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_duration_chk
     CHECK (duration_months >= 1)`);
  await pg.raw(`ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_max_redemptions_chk
     CHECK (max_redemptions IS NULL OR (max_redemptions >= 1 AND redemption_count <= max_redemptions))`);
  await pg.raw(`ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_redemption_count_chk
     CHECK (redemption_count >= 0)`);

  // Three fields, not more: past that the list matches everything and ranks nothing. The ids
  // themselves are validated against the code list, which a CHECK could only duplicate.
  await pg.raw(`ALTER TABLE organizations ADD CONSTRAINT organizations_type_max_chk
     CHECK (cardinality(type) <= 3)`);

  // The discovery CPV filter asks for overlap (`&&`) with a set of codes.
  await pg.raw('CREATE INDEX IF NOT EXISTS tenders_cpv_codes_idx ON tenders USING gin (cpv_codes)');
  await pg.raw(`ALTER TABLE tenders ADD CONSTRAINT tenders_submission_channel_chk
     CHECK (submission_channel IN ('eauction','armeps','paper'))`);
  // A paper invitation reads its own notices through it (ticket 07).
  await pg.raw(`CREATE INDEX IF NOT EXISTS tender_sources_points_to_idx
     ON tender_sources (source, points_to) WHERE points_to IS NOT NULL`);
  await pg.raw(`ALTER TABLE tender_sources ADD CONSTRAINT tender_sources_role_chk
     CHECK (role IN ('discovery','detail','results'))`);
  await pg.raw(`ALTER TABLE unmatched_results ADD CONSTRAINT unmatched_results_reason_chk
     CHECK (reason IN ('no_candidate','ambiguous','no_code','unsupported_format'))`);
  // "Was a notice published on these days": the publicity facts read a span around one date.
  await pg.raw(`CREATE INDEX IF NOT EXISTS listing_notices_published_idx
     ON listing_notices (source, published_at)`);

  await pg.raw(`CREATE INDEX IF NOT EXISTS tracked_tenders_org_status_idx
     ON tracked_tenders (organization_id, status)`);
  await pg.raw(`CREATE INDEX IF NOT EXISTS tracked_tenders_tender_idx
     ON tracked_tenders (tender_id)`);
  // The reconcile job's driving query. Partial, because a bid stops being interesting the
  // moment it resolves and the resolved set is the one that grows without bound.
  await pg.raw(`CREATE INDEX IF NOT EXISTS bids_unresolved_idx
     ON bids (submitted_at) WHERE locked = true AND outcome IS NULL`);
  await pg.raw(`CREATE INDEX IF NOT EXISTS public_tender_bids_supplier_idx
     ON public_tender_bids (supplier_id)`);

  // Enum values are constrained at the DB level. A typo'd status is a silent bad row in a
  // state machine, which is the worst possible place for one.
  await pg.raw(`ALTER TABLE tracked_tenders ADD CONSTRAINT tracked_tenders_status_chk
     CHECK (status IN ('considering','preparing','submitted','won','lost','dropped'))`);
  await pg.raw(`ALTER TABLE tracked_tenders ADD CONSTRAINT tracked_tenders_go_no_go_chk
     CHECK (go_no_go IS NULL OR go_no_go IN ('go','no_go','undecided'))`);
  // A recorded relevance is a score AND what was shown, or neither.
  await pg.raw(`ALTER TABLE tracked_tenders ADD CONSTRAINT tracked_tenders_relevance_chk
     CHECK ((relevance_score IS NULL) = (relevance_shown IS NULL)
        AND (relevance_score IS NULL OR relevance_score BETWEEN 0 AND 1))`);
  await pg.raw(`ALTER TABLE bids ADD CONSTRAINT bids_outcome_chk
     CHECK (outcome IS NULL OR outcome IN ('won','lost','not_found'))`);

  /**
   * A child's organization_id must not be able to disagree with its parent's.
   *
   * Carrying organization_id on every private table is right — each one is filtered by it
   * constantly, and reaching the org through a join is how tenant isolation gets dropped in a
   * refactor. But as two INDEPENDENT foreign keys it is a copy that can rot: Postgres accepted
   * a bid claiming org B whose tracked tender belonged to org A, which is a cross-tenant leak
   * that reads as correct. The composite key makes that unrepresentable.
   *
   * Every child of tracked_tenders takes the same shape; checklists is the other one.
   */
  await pg.raw(`ALTER TABLE bids ADD CONSTRAINT bids_parent_org_fk
     FOREIGN KEY (tracked_tender_id, organization_id)
     REFERENCES tracked_tenders (id, organization_id) ON DELETE CASCADE`);

  // The checklist chain takes the same shape, one level deeper: checklist_items anchors to
  // checklists, which anchors to tracked_tenders. Without it an item would be TWO hops from
  // an organisation and every isolation check a three-table join.
  await pg.raw(`ALTER TABLE checklists ADD CONSTRAINT checklists_id_org_uq
     UNIQUE (id, organization_id)`);
  await pg.raw(`ALTER TABLE checklists ADD CONSTRAINT checklists_parent_org_fk
     FOREIGN KEY (tracked_tender_id, organization_id)
     REFERENCES tracked_tenders (id, organization_id) ON DELETE CASCADE`);
  await pg.raw(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_parent_org_fk
     FOREIGN KEY (checklist_id, organization_id)
     REFERENCES checklists (id, organization_id) ON DELETE CASCADE`);

  await pg.raw(`ALTER TABLE checklists ADD CONSTRAINT checklists_status_chk
     CHECK (status IN ('pending','ready','failed','unavailable'))`);
  await pg.raw(`ALTER TABLE checklists ADD CONSTRAINT checklists_source_chk
     CHECK (source IN ('ai','manual'))`);
  await pg.raw(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_source_chk
     CHECK (source IN ('ai','manual'))`);
  await pg.raw(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_category_chk
     CHECK (category IS NULL OR category IN
       ('eligibility','financial','technical','document','procedural'))`);
  await pg.raw(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_confidence_chk
     CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))`);

  await pg.raw(`CREATE INDEX IF NOT EXISTS checklist_items_checklist_idx
     ON checklist_items (checklist_id, sort_order)`);
  await pg.raw(`CREATE INDEX IF NOT EXISTS checklist_items_review_idx
     ON checklist_items (organization_id) WHERE needs_review = true`);

  /**
   * The document vault.
   *
   * Two uploads of the same bytes are the same document, and the storage key is derived
   * from the content hash — so without the dedupe index the second upload would overwrite
   * the first object while leaving two rows pointing at it. Scoped per organisation
   * because the key is tenant-namespaced: one certificate held by two customers is two
   * objects and two rows, not a shared one.
   */
  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS vault_documents_org_hash_uq
     ON vault_documents (organization_id, hash)`);
  await pg.raw(`ALTER TABLE vault_documents ADD CONSTRAINT vault_documents_id_org_uq
     UNIQUE (id, organization_id)`);
  await pg.raw(`ALTER TABLE vault_documents ADD CONSTRAINT vault_documents_status_chk
     CHECK (status IN ('pending','ready','rejected'))`);
  await pg.raw(`CREATE INDEX IF NOT EXISTS vault_documents_org_kind_idx
     ON vault_documents (organization_id, kind)`);
  /**
   * The expiry sweep's driving query. Partial on two counts: a document with no
   * `valid_until` never expires and must never be scanned — nullable on purpose, a
   * company registration does not lapse — and only a `ready` row has a file behind it
   * worth warning about.
   */
  await pg.raw(`CREATE INDEX IF NOT EXISTS vault_documents_expiry_idx
     ON vault_documents (valid_until)
     WHERE valid_until IS NOT NULL AND status = 'ready'`);

  /**
   * A checklist item cannot be satisfied by another tenant's document.
   *
   * SET NULL rather than CASCADE: deleting a certificate must detach the requirement, not
   * delete it — the requirement still exists, it is simply unmet again.
   *
   * The column list is not optional. A composite SET NULL with no list nulls EVERY column
   * in the key, so deleting an attached document tried to null `organization_id` too and
   * failed the NOT NULL constraint — the delete could not complete at all. Only the pointer
   * is cleared; the tenant anchor is never nullable. Postgres 15+ syntax.
   */
  await pg.raw(`ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_vault_org_fk
     FOREIGN KEY (vault_document_id, organization_id)
     REFERENCES vault_documents (id, organization_id)
     ON DELETE SET NULL (vault_document_id)`);

  /**
   * A contract cannot name an award belonging to a different tender.
   *
   * MATCH SIMPLE — the default, stated because it is load-bearing — makes the whole
   * constraint inert when `award_id` is NULL, which is exactly the single-source case the
   * nullable column exists for. When an award IS named, the pair must agree.
   *
   * SET NULL takes a column list for the same reason checklist_items -> vault_documents
   * does: a listless composite SET NULL nulls EVERY column in the key, so deleting an
   * award would try to null `tender_id` too and fail its NOT NULL. Deleting an award
   * detaches the contract from it; the contract, and its tender, remain.
   */
  await pg.raw(`ALTER TABLE contracts ADD CONSTRAINT contracts_award_tender_fk
     FOREIGN KEY (award_id, tender_id)
     REFERENCES awards (id, tender_id) MATCH SIMPLE
     ON DELETE SET NULL (award_id)`);

  // Every sibling table holding a tender FK carries a leading-tender_id index; this one
  // also backs the cascade when a tender is deleted.
  await pg.raw(`CREATE INDEX IF NOT EXISTS contracts_tender_idx
     ON contracts (tender_id)`);

  await pg.raw(`CREATE INDEX IF NOT EXISTS notifications_subject_idx
     ON notifications (organization_id, type, subject_id) WHERE subject_id IS NOT NULL`);

  /**
   * BR-9 — no duplicate alert for the same event — as a constraint rather than a
   * convention. It was a read-then-insert against nothing: two sweeps raising the same
   * alert in the same tick both read "no existing row" and both inserted.
   *
   * NULLS NOT DISTINCT (Postgres 15+) is the part that makes the key work at all. Every
   * notification has a NULL in it by design — a tender alert carries no `subject_id`, a
   * vault alert carries no `tender_id` — and under the default NULLS DISTINCT two NULLs
   * never collide, so the index would accept every duplicate it exists to stop while
   * looking correct in `\d notifications`. Verified by insert, not by reading the manual.
   *
   * The insert side is `ON CONFLICT DO NOTHING` in `notification.repo.js`: a conflict here
   * is the constraint arbitrating a race, which is success, not an error to surface.
   */
  /**
   * The deferred sweep's own query: channel equality plus a range on
   * `deferred_until`, run once per deliverable channel every ten minutes.
   * Partial on `status = 'deferred'` because that is a handful of rows in a
   * table that grows one row per destination per alert — the index stays small
   * forever rather than tracking the whole table.
   */
  await pg.raw(`CREATE INDEX IF NOT EXISTS alert_deliveries_deferred_idx
     ON alert_deliveries (channel, deferred_until)
     WHERE status = 'deferred'`);

  /**
   * Two jobs. It serves the NOT EXISTS that stops the sweep re-sending an alert
   * already delivered on this channel, and it covers the foreign key — without
   * it, deleting a notification seq-scans this table to enforce the CASCADE.
   */
  await pg.raw(`CREATE INDEX IF NOT EXISTS alert_deliveries_notification_idx
     ON alert_deliveries (notification_id, channel)`);

  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq
     ON notifications (organization_id, type, tender_id, subject_id) NULLS NOT DISTINCT`);

  await pg.raw(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_kind_chk
     CHECK (kind IN ('trial','promo','paid'))`);
  // An empty range overlaps nothing, so a zero-length period would slip past the rule below.
  await pg.raw(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_period_chk
     CHECK (period_end > period_start)`);

  /**
   * One plan at a time: no two non-voided periods of one organization overlap.
   *
   * `planFor` reads "the period covering now" and takes one row; that is only an answer if
   * there can be at most one. Checking for overlap in the service is check-then-act, the same
   * race as the owner seat, so the database arbitrates it. `tstzrange` defaults to half-open
   * `[)`, which is what lets a promo start at the exact moment a trial ends. Voided rows are
   * left out, so voiding a grant frees its time for another. btree_gist supplies the `=` on
   * organization_id inside a GiST index.
   */
  await pg.raw('CREATE EXTENSION IF NOT EXISTS btree_gist');
  await pg.raw(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_no_overlap_excl
     EXCLUDE USING gist (organization_id WITH =, tstzrange(period_start, period_end) WITH &&)
     WHERE (voided_at IS NULL)`);

  /**
   * One trial per organization creator, in any organization. The trial row copies its
   * organization's created_by, so this is an index rather than a join. Voided rows are NOT
   * excluded: a voided trial was still used, or voiding one would hand its creator another.
   * Two organizations of one creator starting a trial at once each hold only their own row
   * lock, so this index, not the service's re-check, decides which one gets it.
   */
  await pg.raw(`CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_trial_creator_uq
     ON subscriptions (trial_creator_id) WHERE kind = 'trial'`);

}

async function init() {
  try {
    const options =
      process.env.NODE_ENV === 'production'
        ? knexConfigs.production
        : knexConfigs.development;

    const pg = knex(options);

    await pg.transaction(async trx => {
      await up(trx);
      await indexes(trx);
    });

    console.log('✅ Successfully created all tables in transaction');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

init();
