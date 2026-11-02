---
description: Moving off Pulley? Export your cap table before December 8, 2026 and import it into Aggregate. Carta and Mantle exports work too.
---

# Moving off Pulley? Bring your cap table.

**Short answer:** export your cap table from Pulley as an Excel file before **December 8, 2026**, when Pulley shuts
down. Then open a company in Aggregate, choose **Cap table → + Import from Pulley, Carta or Mantle** and pick the file.
Aggregate also imports Carta's and Mantle's OCX export, CSV ledgers and Open Cap Table Format (OCF) JSON. Importing the
same file twice never counts anything twice.

**Status:** Live.

<!-- Keep this page true: it describes packages/equity/src/workbook.ts and csv.ts; change it in the same commit. -->

## 1. Export from Pulley (before December 8, 2026)

Pulley's app closes on December 8, 2026. After that there's only limited access until January 31, 2027, so export now.

1. In Pulley, open **Cap Table** and click **Download Cap Table**.
2. Keep **All Time** checked and click **Download**. You get an `.xlsx` workbook.

Upload that workbook as it is. Don't copy tabs into a new file or re-save it as `.xls`.

([Pulley's export guide](https://help.pulley.com/en/articles/17154936-exporting-your-data-from-pulley) ·
[shutdown FAQ](https://pulley2025.pulley.com/guides/faq-what-is-happening-with-pulleys-shutdown))

## 2. Or export from Carta or Mantle (OCX)

OCX is the Open Cap Table Coalition's Excel layout for a cap table.

- **Carta:** download the OCX report. Carta's steps are in
  [How to download the Open Cap Table Excel Standard (OCX)](https://support.carta.com/s/article/open-cap-table-standard).
- **Mantle:** open **Cap Table** and click **Export OCX**. For an earlier date, pick the date first, then export
  ([Mantle's export guide](https://withmantle.com/docs/export)).

## 3. Import it

Open the company in Aggregate, then **Cap table → + Import from Pulley, Carta or Mantle**, and pick the file. Aggregate
shows what it added and lists anything it couldn't read. Right after an import, **Undo** in that message takes the whole
import back. Later, an AI you've allowed to add records can undo it with `void_record`, for 30 days.

## What imports

**From Pulley's workbook,** each tab that lists one security per row is imported:

- **Shares:** common and preferred stock, with issue dates and prices.
- **Options and RSUs:** from the incentive plan tab, with exercise prices, vesting schedules (for example "4 years, 1
  year cliff"), and exercised and cancelled amounts.
- **SAFEs, notes and warrants.**

Totals and "available for issuance" rows aren't holders. The option pool is set to what was granted plus what the file
lists as available. If the workbook also has a summary tab, Aggregate checks the imported tabs against it and lists
every holding that differs.

**From an OCX file,** the stakeholder snapshot is imported. That covers each holder's shares by class (preferred with
its conversion ratio), option plans with what's left to grant, warrants and non-plan awards. Aggregate checks every
column against the file's Total row and its fully diluted total, and says where they don't match.

**What doesn't come across:**

- **An OCX file is a snapshot.** It lists what each holder owns on one date, not each grant. Holdings are dated as of
  that date, with **no issue prices, vesting schedules or grant history**.
- **Option types:** an OCX file doesn't say whether options are ISOs or NSOs, so they come in as NSOs. Change any that
  aren't.
- **Preferred terms:** a new preferred class comes in as 1x non-participating. Change it if your terms differ.
- **Convertibles:** SAFEs and notes aren't in an OCX snapshot. Add them yourself, or import a file that lists them.
- **Old `.xls` and password-protected files:** they aren't read. Re-save as `.xlsx` without a password.

If you have both, import Pulley's full workbook or a ledger CSV rather than a summary, so you keep the history.

## Duplicates: flagged, never doubled

- **The same file again** adds nothing.
- **A summary onto a cap table that already has holdings** adds nothing if they match. If they differ, nothing is
  imported and Aggregate lists the differences, holder by holder.
- **A full workbook onto a cap table built from a summary** is refused, because every share would count twice. Undo the
  summary import, then import the full workbook.

## Questions people ask

**Can my AI read the cap table once it's in?** Yes. Claude, ChatGPT or any assistant connected to Aggregate can answer
questions like "who owns what, fully diluted?" using `get_cap_table`, within what you let it see.

**Can Aggregate change anything in Pulley or Carta?** No. Aggregate only reads the file you upload. It doesn't connect
to Pulley or Carta.

**What about Pulley's other reports?** The cap table workbook is what imports. Keep the other reports and your signed
documents (grants, SAFEs, board consents, 409A reports) somewhere safe too. Pulley won't have them after it closes.

See also: [Known limits](limits.md#cap-tables).

*Last checked: 2026-10-12.*
