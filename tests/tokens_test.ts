import { assertEquals } from "@std/assert";
import {
  countEscapedAmpersands,
  findFormattingCodes,
  findPlaceholders,
  protectedTokensOf,
} from "../src/quests/tokens.ts";

function placeholders(text: string): string[] {
  return findPlaceholders(text).sort();
}

Deno.test("plain printf conversions are detected", () => {
  assertEquals(placeholders("You need %s more"), ["%s"]);
  assertEquals(placeholders("Level %d"), ["%d"]);
  assertEquals(placeholders("%f stress"), ["%f"]);
  assertEquals(placeholders("colour %x"), ["%x"]);
});

Deno.test("width, precision and flags are part of the token", () => {
  // Splitting %02d into %d plus a literal "02" would let a model reorder the
  // digits without the validator noticing.
  assertEquals(placeholders("Time %02d:%02d"), ["%02d", "%02d"]);
  assertEquals(placeholders("%-10s|"), ["%-10s"]);
  assertEquals(placeholders("%.2f SU"), ["%.2f"]);
  assertEquals(placeholders("%+d and %#x"), ["%#x", "%+d"]);
  assertEquals(placeholders("%,d items"), ["%,d"]);
  assertEquals(placeholders("%(d owed"), ["%(d"]);
});

Deno.test("positional and relative argument indexes are part of the token", () => {
  assertEquals(placeholders("%1$s needs %2$s"), ["%1$s", "%2$s"]);
  assertEquals(placeholders("%1$.2f SU"), ["%1$.2f"]);
  assertEquals(placeholders("%12$08.3f"), ["%12$08.3f"]);
  // Java's `%<` reuses the previous argument.
  assertEquals(placeholders("%s (%<s)"), ["%<s", "%s"]);
  assertEquals(placeholders("%d/%<,d"), ["%<,d", "%d"]);
});

Deno.test("C-style u and i conversions are detected", () => {
  assertEquals(placeholders("%u units"), ["%u"]);
  assertEquals(placeholders("%i items"), ["%i"]);
  assertEquals(placeholders("%05u"), ["%05u"]);
});

Deno.test("the full java.util.Formatter conversion set is detected", () => {
  for (const conversion of "bBhHsScCdoxXeEfgGaAn".split("")) {
    assertEquals(placeholders(`value %${conversion} here`), [`%${conversion}`], conversion);
  }
  // Date/time conversions carry a second letter: %tY, %TH.
  assertEquals(placeholders("%tY-%tm-%td"), ["%tY", "%td", "%tm"].sort());
  assertEquals(placeholders("%TH:%TM"), ["%TH", "%TM"].sort());
});

Deno.test("a literal %% is one token and does not spawn a second one", () => {
  assertEquals(placeholders("100%% done"), ["%%"]);
  // "%%s" prints a literal "%s"; it must not also be reported as %s.
  assertEquals(placeholders("%%s"), ["%%"]);
  assertEquals(placeholders("%%%d"), ["%%", "%d"]);
});

Deno.test("prose percentages are not mistaken for placeholders", () => {
  // The space flag is deliberately not recognised: "50% stronger" would
  // otherwise scan as the conversion "% s" and fail every honest translation.
  assertEquals(placeholders("Deals 50% more damage"), []);
  assertEquals(placeholders("50% stronger"), []);
  assertEquals(placeholders("Reduced by 100%"), []);
  assertEquals(placeholders("Efficiency: 75%."), []);
  assertEquals(placeholders("costs 10% (rounded)"), []);
  assertEquals(placeholders("a 5% chance"), []);
});

Deno.test("formatting codes and printf tokens are collected together", () => {
  assertEquals(protectedTokensOf("&6%1$s&r has %02d"), ["&6", "&r", "%1$s", "%02d"]);
});

Deno.test("formatting codes are unchanged by the printf work", () => {
  assertEquals(findFormattingCodes("&aGreen&r"), ["&a", "&r"]);
  assertEquals(findFormattingCodes("\\&6 literal"), []);
  assertEquals(countEscapedAmpersands("Bells \\& Whistles"), 1);
});

Deno.test("brace, dollar and angle placeholders still work alongside printf", () => {
  assertEquals(placeholders("{image:x} %s <player>"), ["%s", "<player>", "{image:x}"].sort());
  assertEquals(placeholders("$(tooltip) %1$s"), ["%1$s", "$(tooltip)"].sort());
});
