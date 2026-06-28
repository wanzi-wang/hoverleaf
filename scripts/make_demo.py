#!/usr/bin/env python3
"""Generate a realistic econ working paper with exhibits at the back."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak)
from reportlab.graphics.shapes import Drawing, String
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.lib.colors import HexColor
import os

OUT = os.path.join(os.path.dirname(__file__), "demo.pdf")
ss = getSampleStyleSheet()
body = ParagraphStyle("body", parent=ss["BodyText"], fontName="Times-Roman",
                      fontSize=10.5, leading=15, alignment=4, spaceAfter=8)
h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontName="Times-Bold", fontSize=13, spaceBefore=10, spaceAfter=6)
title = ParagraphStyle("title", parent=ss["Title"], fontName="Times-Bold", fontSize=18, leading=22)
sub = ParagraphStyle("sub", parent=ss["Normal"], fontName="Times-Italic", fontSize=11, alignment=1, spaceAfter=2)
cap = ParagraphStyle("cap", parent=ss["Normal"], fontName="Times-Bold", fontSize=10.5, spaceBefore=6, spaceAfter=4)
note = ParagraphStyle("note", parent=ss["Normal"], fontName="Times-Italic", fontSize=8.5, leading=11, textColor=colors.grey, spaceBefore=3)

TEAL = HexColor("#2f7d6b")
TERRA = HexColor("#b4531f")

def para(t): return Paragraph(t, body)

story = []
# ---------- Title ----------
story += [Spacer(1, 0.5*inch),
          Paragraph("Coffee, Commits &amp; Causal Effects:<br/>Caffeine Access and Local Productivity", title),
          Spacer(1, 10),
          Paragraph("A. Researcher &nbsp;&middot;&nbsp; B. Coauthor", sub),
          Paragraph("Working Paper &middot; This version: June 2026", sub),
          Spacer(1, 18)]

abstract = ("<b>Abstract.</b> We study how the opening of specialty coffee shops affects local "
            "labor productivity using a staggered difference-in-differences design. Summary "
            "statistics are reported in Table 1. Our headline event-study estimates, plotted in "
            "Figure 1, show a 3.1% rise in output per worker within two years of entry. The main "
            "regression results appear in Table 2, and robustness to alternative bandwidths is "
            "documented in Figure 2. Heterogeneity by sector is summarized in Table 3, while the "
            "geographic distribution of treatment timing is mapped in Figure 3. Effects are "
            "concentrated among knowledge-intensive firms (see Table 2, columns 3 and 4).")
story += [Paragraph(abstract, body), Spacer(1, 10)]

# ---------- 1. Introduction ----------
story += [Paragraph("1. Introduction", h1)]
story += [para(
    "Economists have long speculated about the wellspring of urban productivity. We revisit the "
    "question through an unlikely lens: caffeine. As shown in Table 1, treated and control "
    "counties are well balanced on pre-period covariates, with standardized differences below "
    "0.05 across all dimensions. This balance motivates our identification strategy.")]
story += [para(
    "Figure 1 previews the main result. Prior to a coffee shop&rsquo;s opening, productivity in "
    "treated and control areas trends in parallel&mdash;an assumption we cannot test directly but "
    "for which Figures 1 and 2 provide suggestive support. After entry, treated counties pull "
    "ahead. The point estimates in Table 2 confirm this pattern, and the dynamic coefficients in "
    "Figure 2 rule out anticipation effects in the four quarters before treatment.")]
story += [para(
    "Our contribution is threefold. First, we assemble a novel panel linking coffee-shop permits "
    "to administrative productivity records. Second, we document substantial heterogeneity: "
    "Table 3 shows that effects are three times larger in software and finance than in "
    "manufacturing. Third, the spatial analysis in Figure 3 demonstrates that spillovers decay "
    "sharply beyond a two-kilometer radius. Together, Tables 2 and 3 paint a consistent picture.")]

# ---------- 2. Data ----------
story += [Paragraph("2. Data and Descriptive Statistics", h1)]
story += [para(
    "Our sample covers 1,204 counties from 2008 to 2024. Panel A of Table 1 reports firm-level "
    "characteristics; Panel B reports county aggregates. The average treated county hosts 4.2 "
    "specialty coffee shops by the end of the sample, compared with 1.1 in the median control "
    "county. Figure 3 maps the rollout of treatment across the study region.")]
story += [para(
    "We measure productivity as real value added per worker, deflated to 2020 dollars. "
    "Outliers above the 99th percentile are winsorized. As Table 1 makes clear, the two groups "
    "are comparable at baseline, which is reassuring given our reliance on a parallel-trends "
    "assumption examined in Figure 1.")]

# ---------- 3. Empirical Strategy ----------
story += [Paragraph("3. Empirical Strategy", h1)]
story += [para(
    "We estimate a two-way fixed-effects event study. The coefficients of interest trace the path "
    "of productivity relative to the quarter of entry; these are exactly the coefficients plotted "
    "in Figure 1. To address recent concerns about negative weighting in staggered designs, we "
    "also report the heterogeneity-robust estimator of Table 2, column 4.")]
story += [para(
    "Identification rests on the timing of permits being as-good-as-random conditional on county "
    "and time fixed effects. The covariate balance in Table 1 supports this view. We probe "
    "sensitivity to bandwidth choice in Figure 2 and to sample composition in Table 3.")]

# ---------- 4. Results ----------
story += [Paragraph("4. Results", h1)]
story += [para(
    "Table 2 presents our main estimates. The coefficient on post-entry exposure is 0.031 "
    "(s.e. 0.009), implying a 3.1% productivity gain. This estimate is stable across the "
    "specifications in columns 1 through 4. The event-study plot in Figure 1 shows the effect "
    "emerging gradually and stabilizing after six quarters.")]
story += [para(
    "Heterogeneity is economically meaningful. As reported in Table 3, the effect for "
    "knowledge-intensive sectors reaches 5.8%, while manufacturing shows a precisely estimated "
    "null. Figure 2 confirms that these conclusions are insensitive to the choice of estimation "
    "bandwidth. Finally, Figure 3 reveals that productivity gains are tightly localized.")]
story += [para(
    "Taken together, Tables 1, 2 and 3 and Figures 1&ndash;3 support a causal interpretation: "
    "access to specialty coffee raises measured productivity, with effects concentrated where "
    "cognitive work predominates.")]

# ===================================================================
#                        EXHIBITS (at the back)
# ===================================================================
story += [PageBreak()]
story += [Paragraph("Table 1&mdash;Summary Statistics and Covariate Balance", cap)]
t1data = [["", "Treated", "Control", "Std. Diff."],
          ["Value added / worker ($k)", "82.4", "81.9", "0.012"],
          ["Employment (100s)", "14.2", "14.6", "0.031"],
          ["Firm age (years)", "11.8", "12.1", "0.024"],
          ["Share college-educated", "0.38", "0.37", "0.041"],
          ["Coffee shops per 10k", "2.10", "0.95", "&mdash;"],
          ["N (county-quarters)", "38,528", "39,104", ""]]
t1 = Table([[Paragraph(c, ParagraphStyle('t', fontName='Times-Roman', fontSize=9)) for c in row] for row in t1data],
           colWidths=[2.4*inch, 1.0*inch, 1.0*inch, 1.0*inch])
t1.setStyle(TableStyle([
    ("FONT", (0,0), (-1,0), "Times-Bold", 9),
    ("LINEABOVE", (0,0), (-1,0), 1, colors.black),
    ("LINEBELOW", (0,0), (-1,0), 0.5, colors.black),
    ("LINEBELOW", (0,-1), (-1,-1), 1, colors.black),
    ("ALIGN", (1,0), (-1,-1), "CENTER"),
    ("TOPPADDING", (0,0), (-1,-1), 3), ("BOTTOMPADDING", (0,0), (-1,-1), 3)]))
story += [t1, Paragraph("<i>Notes:</i> Standardized differences below 0.10 indicate good balance. "
                        "Statistics are pre-treatment means.", note)]

story += [Spacer(1, 24)]
story += [Paragraph("Table 2&mdash;Effect of Coffee-Shop Entry on Productivity", cap)]
t2data = [["", "(1)", "(2)", "(3)", "(4)"],
          ["Post-entry exposure", "0.028", "0.030", "0.031", "0.031"],
          ["", "(0.010)", "(0.009)", "(0.009)", "(0.009)"],
          ["County FE", "Yes", "Yes", "Yes", "Yes"],
          ["Time FE", "Yes", "Yes", "Yes", "Yes"],
          ["Controls", "No", "Yes", "Yes", "Yes"],
          ["Estimator", "TWFE", "TWFE", "CS", "CS"],
          ["Observations", "77,632", "77,632", "77,632", "77,632"],
          ["R-squared", "0.81", "0.83", "&mdash;", "&mdash;"]]
t2 = Table([[Paragraph(c, ParagraphStyle('t', fontName='Times-Roman', fontSize=9)) for c in row] for row in t2data],
           colWidths=[1.9*inch, 0.85*inch, 0.85*inch, 0.85*inch, 0.85*inch])
t2.setStyle(TableStyle([
    ("FONT", (0,0), (-1,0), "Times-Bold", 9),
    ("LINEABOVE", (0,0), (-1,0), 1, colors.black),
    ("LINEBELOW", (0,0), (-1,0), 0.5, colors.black),
    ("LINEBELOW", (0,-1), (-1,-1), 1, colors.black),
    ("ALIGN", (1,0), (-1,-1), "CENTER"),
    ("TOPPADDING", (0,0), (-1,-1), 2.5), ("BOTTOMPADDING", (0,0), (-1,-1), 2.5)]))
story += [t2, Paragraph("<i>Notes:</i> Dependent variable is log value added per worker. "
                        "Standard errors clustered by county in parentheses. CS = Callaway and Sant&rsquo;Anna (2021).", note)]

story += [PageBreak()]
story += [Paragraph("Table 3&mdash;Heterogeneity by Sector", cap)]
t3data = [["Sector", "Effect", "Std. Err.", "N"],
          ["Software", "0.058", "(0.014)", "12,880"],
          ["Finance", "0.049", "(0.016)", "10,112"],
          ["Professional services", "0.034", "(0.012)", "18,400"],
          ["Retail", "0.012", "(0.008)", "21,344"],
          ["Manufacturing", "0.003", "(0.007)", "14,896"]]
t3 = Table([[Paragraph(c, ParagraphStyle('t', fontName='Times-Roman', fontSize=9)) for c in row] for row in t3data],
           colWidths=[2.2*inch, 1.0*inch, 1.0*inch, 1.0*inch])
t3.setStyle(TableStyle([
    ("FONT", (0,0), (-1,0), "Times-Bold", 9),
    ("LINEABOVE", (0,0), (-1,0), 1, colors.black),
    ("LINEBELOW", (0,0), (-1,0), 0.5, colors.black),
    ("LINEBELOW", (0,-1), (-1,-1), 1, colors.black),
    ("ALIGN", (1,0), (-1,-1), "CENTER"),
    ("TOPPADDING", (0,0), (-1,-1), 3), ("BOTTOMPADDING", (0,0), (-1,-1), 3)]))
story += [t3, Paragraph("<i>Notes:</i> Each row is a separate regression on the sector subsample.", note)]

# ---------- Figure 1: event study line plot ----------
story += [Spacer(1, 26)]
d = Drawing(420, 200)
lp = LinePlot()
lp.x = 40; lp.y = 30; lp.width = 350; lp.height = 150
pts = [(-4,-0.002),(-3,0.001),(-2,-0.001),(-1,0.0),(0,0.004),(1,0.012),(2,0.020),(3,0.027),(4,0.030),(5,0.031),(6,0.031)]
zero = [(-4,0),(6,0)]
lp.data = [pts, zero]
lp.lines[0].strokeColor = TERRA; lp.lines[0].strokeWidth = 2
lp.lines[1].strokeColor = colors.grey; lp.lines[1].strokeWidth = 0.5
lp.xValueAxis.valueMin = -4; lp.xValueAxis.valueMax = 6
lp.yValueAxis.valueMin = -0.01; lp.yValueAxis.valueMax = 0.04
d.add(lp)
d.add(String(160, 6, "Quarters relative to entry", fontSize=8, fillColor=colors.grey))
story += [d, Paragraph("Figure 1&mdash;Event-Study Estimates of Productivity Around Entry", cap), Paragraph("<i>Notes:</i> Coefficients from a dynamic event-study specification with 95% confidence "
                       "intervals. The omitted period is quarter &minus;1.", note)]

# ---------- Figure 2: bar chart robustness ----------
story += [PageBreak()]
d2 = Drawing(420, 210)
bc = VerticalBarChart()
bc.x = 40; bc.y = 30; bc.width = 350; bc.height = 160
bc.data = [[0.029, 0.030, 0.031, 0.032, 0.030, 0.031]]
bc.categoryAxis.categoryNames = ["0.5x","0.75x","1x","1.25x","1.5x","2x"]
bc.valueAxis.valueMin = 0; bc.valueAxis.valueMax = 0.04
bc.bars[0].fillColor = TEAL
d2.add(bc)
d2.add(String(150, 6, "Bandwidth multiplier", fontSize=8, fillColor=colors.grey))
story += [d2, Paragraph("Figure 2&mdash;Robustness to Bandwidth Choice", cap), Paragraph("<i>Notes:</i> Each bar re-estimates the headline coefficient under a different "
                        "estimation bandwidth. Estimates are stable around 0.031.", note)]

# ---------- Figure 3: stylized map (bar grid) ----------
story += [Spacer(1, 22)]
d3 = Drawing(420, 200)
import random
random.seed(7)
for gx in range(14):
    for gy in range(8):
        shade = random.random()
        col = HexColor("#%02x%02x%02x" % (int(180+60*shade), int(83+120*(1-shade)), int(31+80*shade)))
        from reportlab.graphics.shapes import Rect
        d3.add(Rect(30+gx*26, 20+gy*20, 24, 18, fillColor=col, strokeColor=colors.white, strokeWidth=1))
story += [d3, Paragraph("Figure 3&mdash;Geographic Distribution of Treatment Timing", cap), Paragraph("<i>Notes:</i> Darker cells indicate earlier treatment. The grid is a stylized "
                        "representation of the study region.", note)]

doc = SimpleDocTemplate(OUT, pagesize=letter, topMargin=0.8*inch, bottomMargin=0.8*inch,
                        leftMargin=1.0*inch, rightMargin=1.0*inch,
                        title="Coffee, Commits & Causal Effects")
doc.build(story)
print("wrote", OUT)
