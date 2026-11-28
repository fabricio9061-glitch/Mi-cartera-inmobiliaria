/* ============================================================================
   INFORME DE PORTALES EN PDF
   ----------------------------------------------------------------------------
   El botón "Imprimir informe" del modal de Portales. Mismo modelo que los otros
   informes del CRM (tasador, terreno, usufructo): portada con el logo y los
   datos de la propiedad, y después hojas con el encabezado azul, títulos con
   ícono y el pie de MALAVE.

   Es un informe TOTAL: una hoja de resumen con todos los portales y una hoja
   por portal (Mercado Libre, InfoCasas, Casas y Más) con su estado, lo que ve
   el cliente, la calidad del aviso, los números y el gráfico de los últimos 30
   días. Los datos los arma app.js (imprimirInformePortales) con lo que el modal
   ya consultó: acá solo se dibuja.

   Se carga solo cuando se abre el modal de Portales, junto con jsPDF.
   El motor de dibujo (medidas de letras, párrafos, tablas, skyline) es copia
   del de usufructo.html: si se corrige algo ahí, conviene corregirlo acá.
   ========================================================================== */
(function () {
  'use strict';
  var LOGO_ISO = "data:image/png;base64,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";
  var LOGO_TXT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAApCAYAAACPxxRyAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAARxUlEQVR42u1debRVZRX/7XMvGCoQaJoaaDbpykIbrNAys9BUxBTJOU0tbRAqLcsUsYlsNahhk5llCppDmIpDZUpYLG3ZoDY5VBqp+FQQEnr3nl9/nL29+51353smnvdb664D9953zzfsvb/f99vDAfqt3/qt3zaQJvE3SErsc4oIs+iM3lsAPHe/rO7dQ39R9L6SDPyc1ror4UgUaj/eIqxJXE7Slpesx99ofIkZqQLbgH7rt0Irz/O1r0VpZZs4ESHJcQCuB7AxgBDAIID3Abg/zR1ZFy4AMBbADwBMBlDR/s0WkV+TDIqCCEiWdH6mAPi+vn2UiNxXtH6KSJXkRwAcC6CqCDYAcLOIfLpI/U0CWYhISHI+gGkAVgCYoWuV+U7t5v9M7UdV5z4A8Iz2cb3pX0LIahSAiwG8UlHWe0Tk4aTuUWeutwVwdZ2vhDbvXbYqgBKAL4vI1TaXQyw9yYkkqxzafuyUNK2FNcP5dQ5vB6R9/y4NFkhe5fp5KcmgoP1cWmdeHxmJyIrkxiSfduM80stYTvN/NOu3vZKSbZU9IbmD+/0bSZbTkEk1jojdL412il+/+CJSLf9YZx1nkfwigD+nsRur5a+Q3EpRQMX1peT+XyR+JCS5s+6ag7pjTtd5W530bpZAW63r6RHW0yPstGCy8kEA4wA8C+AFAM4geVWSSKYD7qWq8nIJgBMB7KrrQEVCc0ne3iMScbeTkOSpus7rAJyqupXmJhpHUoaMfg3gbpW1sMvfDQD8xv1/2O40geRqtWwhyYqhh7RQjkNX39B7DerV7r1fkRCW2zWvcP0dVGQ6J6/dvEVfb3Rzagj6zyMJXSnCmEhyhY6v6mTocP1OHijL5PuEmHzbOuzcq3zr2ITkGJKPqO7e45FXigjrlTFE9D+9npTGfAZt7FohgJkkd1RkESQ86JDk9gBOcKiqyMeOkOQEAG9z/TVe4hSS4wFU+4Rqpq2syP9gAFsp0jJPGQHMVGSVB+o1WbgewFMqL74vx6ge9CIvJR3fsQC20d/6inHDOaH9TfU4Okav3b6CTgyWQbHRAE7XgSepiCUVtJmIiP5Kwr+f+LFD5+AkAFvqcdDmsarCcrR+p9S3I9kZBb0eEjMGZZXf/UhO0SNapuuishCIyAoA56t8h073jgUwpsdNLiQ5BsAndeyrANwUm5us22gRqQCoiEgvr7BdgxXGFn0WyVe7c3kSaKVCcmsAH0DNg7IhoKs5zpBLjAM8yP273zI49ip383YA73T80BDlAXBmvt2kAFhodkxfVQCbAjjIDFu34wewC4BJ+rvLROTRnNCVbd6/H8Y9JayMcQ7LN+MCFibF0dThrhrdsxAcluvvZ1wfryG5MtbnkOQeBenziOewSJaUp7lVx7XaeUWrsesuyvWUcupnieRixw8/txYkN+2Gb3LewSWOe94nbflrwGGFen2W5ERvW9I0WKv0pvfEDIiRhbMSIAkDfU0iuUYX7gGS/65D+OdusBypuTnJR7V/T+n5/FbXX+vzL/2i9g1WepuIrss7nGG6huS2bvMInexenZcsuQ3vkAbOpd07NabOaLzWrevSLGSvhcFaR3KbNAxW0IQPOB/APY4TsO+eQXJ0j0ceC4/4BIBNFMYuVeheZO5qqnJXAuCbIvIsgAvdsdCcFHuSnKZHgT6XlV4LdV0+42R0kYj8E8CP3bHLiO49SI5TWiNrrtTueSOAh5ysGH0wu4vjmyGyWag5Gc52KW65rk3a/IwhrAG1ktNJHtFgNzi026Ohu9c2iuaqiuZmxOB7kRCWIcJluotUNWBOSI4i+QfXZ5uri5M6PvcRVlM52krRbqhod7wevbYnuVbH61HW6Xmti0NZH4zJuIVgvK5dlOVQ/1iST+jv3J1V8HIbCGurrBCWtQkicimAlagR75aYfLpOfthFh2wyP4UowC8AsACR2/ff6D7QLFVSF1EaxVSdgyUA/gZglIgMAvicQ5y2m0/XRavmfTQcoc3k6FQAL9R1uUxEViEKc3gQwKUOZZmcHqQKnVeIgwWS/svJeqjjObADT7zJ1DQdPwFcrrJaBE+7pKmU9RDW8W438JxS1yjLIZXJyl2R5H9IbkRyS8cPFYbD0v6OVnRl49/VEami1/sd+rLd/Gs5931EIixHNL+E5DM674+QfKF+ZtzWjm7n9zK1T44oy9bku+70Yv1boTyptAICDuGYXD6tucCZcKdtIKzNnb63/erFYB3jPr8lJvChHuOCTibHQeJz3e8Zib+Zi9KtFsFgOeHa2S3ItbHP7HpOzFMYqsdqUjsC2DdYXR2tznXK8tHYZyWSLyB5lxu7rc0dWSl2E0V/Gcn1TslN3qe3MqbuN16lMhaSXJSlB7RJpLtlfRycNcI6xp2Vd69z5ibJk8xd28E9XqLcVUhyidsxJ5F8vEgIy7nMFzjBentMMYxL2FJ3uXj/v16A3Xwkclglkv/Uuf6bemzFyZmNfX9VovgJYZ8c5SrQ/i+PeZhDRUzSzJhaQjPJS5yh2DXL8bSRmnOOnqReptd2XpPa2kRaGKzRev15HQTxlIPnrSCsKfh5bnC7ub/fTCFxIQyWM0Sb6jipx75x8XgZN7bPx2B+VXfA7VoJYd9gdYyujnBj+ZK+N6qBXP+jDnJfrggszxCHA2NG1K77NkJLscoqa/X795LcJEv5amKwrK3v4LVOrwMkN2tG1rczQPvDeUrsmcs0RBSl+9lWUbpa5aFCcjKiVAQAuFFElkGjcUVkAMBaxCqO5tgsSngWoioMVQDzRWQ1osx430f79yLU0i5sjsYC2LfbSOZ+G6aslobyWZ3PCoCF+lm1ATH/QwxNiSGiygnb6u9lbbQsxOEOAE9gaN4jAHysSYiDydBRiKpRVAF8XkTWFky+Rnfw2kivE1uR9eU2JzcQkaUkb0Hklag6pfw0yYsArGhSfiYgCQCnqZGrAjjbK7sr4lcUxaAqxmkq+KsAXG5KM8Si19KV7gNwC4C9MTTV6ESS30ct97DfumtlNVD7A9hB37tERP44pMBbrZkX+3wAHwEwQeXNvHKzReRDKpuZNS2WWRaRx0l+E8BZOi6LzXojyVcAuL9OSRyTveNVvlYCuLqBwc6jWf++CuB2HVO7/aogKoXUvNhiiyNh2R0tdotxWHFvWLnJsWRXR1wvqXfM02h35k26Oy/T8Q7ifs88UC2OX1MbxJMdkXWJk5F2JHTjudxxins14wjd8WtuHa/cGpLbNTuCZEA5xKmQwdgxtxzj7Syy3wj7rzaTy4yPhHbs/h/JnVI59rS5I1R1B1umCMISHG1HOE6TmOvFHJkgHO6OlJ8rePkVG5tlv/9Xj4MNy766OboDUZxW4HYWAjikX0y/NwXROX4tgAP17bsB3K4yV22x41+DWtkZQyObANgndnzMDGUhyqAYAHCd65MdD2eQ3AhDqzgY2no/aon3FzaTyzyoFO3LQAclZEodVUZthbBiu1vcYzjYyBvmCPVtHUG4pBFiKgLCcuN8ve5iJPntdvrg5mrvOl7VdSRfk9NYNniE5YT7SrejH9QMXdWZh8VOZivOkbKxoZesEaPqx1SVjzgq/0Dse6LeNPOm36wxgrl4OhsgLIvDelFqyLUdgxXr5OI6HsM15pZ037PrL93331R0g6VjWOwC8l7ajpfPCdV4kg/VCSS9oh0F6xushvP6YlWGkOSdmhYVdGAY3tCA0jguy3VpoPh31QlxWO42ftsMT3YG4rAC9LtRHNbhafQt6LyfFCX8VrnjXqjw+hMKTwNXp2gagD0V5t4sIssbEKSFOHboWF6uxC4B3CQiD6FWbLAVzA80PeQc1Dyeltp0sBaSq7CfFN1Js+TzoxHVuhIAF2haVEsZVlkLROQuRE94CdzxKwRwmoZE5CGTpkPfxdAkegCYQnKqypAl0h+l/38QwE0FItvh6I8AkQfWjy97g+XO3SsBXBDjsioAPkzyHVpp0JIwz9qAuCvjCN7ruI7LzGvY5m9YGekfAXjAKYUt5Bn98smdoSs18OMRFU4UAANOWcMODcOFMcWiblDvV+9d1huJeTJ/COCvTl6qiNz9R6lMhgAOBfAGHctiEXkSUd5kEbnRdWkRZJ02IwG/AeBJt+iiSGKuav4ggHcBeIt+tkREfqM7XRHRlcX4TARwsr79WxFZrIas2qbFM5S1FlFCdzz+510AxiVVufX5gK70eiKieu0C4DtacrjUwVOcTG5vA3Avag4jU/bDc9ohDQSsB7DYyYslaB9A8kX6vcP0vQqASwqIrnwbUwiD5RTycQDfxnCP4dtIztCvz3UTPK/gimGBonMAbK59PrtLWGtK9C1Ej5sqoeYFGqvK1+2G8TwEWQwQeQaJKO7ovBaewUZyWxaR/wK4AkNrZYUAdtP0ljBHlHUhIo+03b8KYGsAx2pBvHfq+wtF5G7U6soVSo90Pv/ukGwq6KIl6e6/r0TgFq4WURhLjD7AEXHX69+18rLlRrq7/K57Xeb8mG4Tlx3hfZGLrzEvymMaf5NqUvSGTro7snxvN3dXNpLLNtdYlChe537TyHdLbM8jKdrW6gInL6ZPS0nOc/r07m7nIEl90WsjL2HTFJtMDZZ/n+QXYotODWF40g3gze1kkudlsJywHOD6fEYvgZ5O2faLzY9dZ+v3RvUNVkuluNUp8W69yIOT2wV1AkkHUq1F3p4x3T62uTFWIudPWo4pyJMLbcNgbZ3GPPayk3guawBDcwA3RpQGIQBuEJHfFpW7cseOMqL8NAHwH0RFBdEtR6BjFQA3A/id8ntVN08Hx46P/RZTCPUyTwaws87bLSKyrEcvs833fABrnA5UEeWyzY5xZ1lxWVZ472EAd9aRPfv8C8p3ScEDkVPpW9DDBBuXtRLAdzA0ZyhElDf3LICziuwVcxVF9wTwRn37IvXAlHoUClHnw9lubowzeSvJaXk8K28DaRbP9ylEFTWBBLzMagTLIvIwgIsxPML8ZA16zMMpEqi8fBnDHx8XIAol+lWH3tGRJRQJkIUl3a3+5IxWiChe5hwRuVMVv1rwubCHcFYA/DQJoXAPO/gZgH9gePnnuZp+kUeTHp/IW07L0Drv1zgAR+q6XJugl9niCReoYbCnd1fVOJ6cU3UNk5dlAB5zRtSQ+fdyfN5gV/IFoFcZCxIzWFZ/WkSeAXAZai7ZMqKQhwWdenNyOIeHmhl/tPb/Og0wTMoDY8K1CMNd1lMRxQCFOezmvT6Rt5LiJmRzNgNRdQ9RNAQkEIjojusPIXpaUzz05Ej9XiXjY6GFODwB4NyYsQoR5UMW/jSv13UqI4NJPvm5HqFc0UmqtDnJFT1WzSc5E8AU/eh8EVmp8Lvdha/oy9cGYroyIiHJUxAlk1YQPVAiyRY6ru9DihoqznCdICJzFK2kBfOrbl3tPlto/qe0EL56SMOUe7mILGxSVqiXOQtQSz7/C4CfJxx3FIjIepILALxVKYxRen0xyX1F5IYcsjKqLsThTKejt4nIHZYEXjADVakjL4tI3of2Hipj/JzUkbGfKG9Zk7FYFUPzIn1M32vpJXPeqOku/25ip1U21bMYbwf6eySMrqBPA2aaD9p0nql5Daoz7uD7lCQ/p9elTKctbldGupirj7v7zNf3RiW5/q68y2N1xvaAVpvNKym6pA+FtfbhpOc6If3Zkem2U/y4ywZFdVHWKh+1B2pekpYIx0VtXw/gKrWKT3ax887RI8DrEOUmPoPoYa5IEX2UEaXRvEI5pTQqntqueR6A3QGM193kX4i8qTsoikhaMWwclwP4KaIgxAmIghPXANgeUc4X65C8AuAGRB7T/RE9QJYYGnB5Zwoo2H5rJYBrFfmeq/KV2BHNke8DJL+olECoa/ILADspAs/joaumU/MATFY+q2iR7bZOjyIqkPgX91kJwExEFVFb/YYAuFL1b4pDViZjD2Zw0so+jqXf+q0vpyO/SYNjBG0X6hYqdvm35dhZWFB7HHmaAhv0MuYO7+URnKR9T7cmQZ1dii12rpJDt2yABJhin5/7bwYy4HUi0HvmimZ84b605yAB/ZE6vFS7/TWbE2YpY/3Wb/3Wb6m2/wMRAwJEopdLMgAAAABJRU5ErkJggg==";
  var LOGO_ISO_DARK = "data:image/png;base64,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";
  var LOGO_TXT_DARK = "data:image/png;base64,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";

  var PDF = {
    navy: [22,39,63], gold: [201,162,39], goldOsc: [168,130,24], tinta: [44,51,64], texto: [58,65,80],
    gris: [106,114,128], gris2: [138,138,138], linea: [230,232,236], fondo: [245,246,248], claro: [247,248,250]
  };
  var PDF_CAB = 66, PDF_PIE = 48;
  var PDF_WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

  // Deja solo caracteres que las fuentes del PDF pueden dibujar. Lo demás
  // (emojis, flechas, espacios raros que mete el sistema) se cambia o se saca.
  function pdfTxt(s) {
    s = String(s == null ? '' : s)
      .replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, ' ')
      .replace(/[\u2010\u2011\u2012\u2212]/g, '-')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], c = s.charCodeAt(i);
      if ((c >= 32 && c < 127) || (c >= 160 && c <= 255) || PDF_WINANSI_EXTRA.indexOf(ch) >= 0) { out += ch; continue; }
      var base = ch.normalize ? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
      if (base && base.charCodeAt(0) >= 32 && base.charCodeAt(0) < 256) out += base;
    }
    return out;
  }
  // Espacio que no se corta: para que "USD 189.382" no quede partido en dos renglones.
  function nb(s) { return String(s).replace(/ /g, '\u00a0'); }

  function pdfNuevoDoc() {
    var pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
    return { pdf: pdf, W: 595.28, H: 841.89, M: 34, y: 0, fin: {} };
  }
  function pF(pdf, estilo, tam, color) {
    pdf.setFont('helvetica', estilo || 'normal'); pdf.setFontSize(tam);
    if (color) pdf.setTextColor(color[0], color[1], color[2]);
  }
  function pFill(pdf, c) { pdf.setFillColor(c[0], c[1], c[2]); }
  function pDraw(pdf, c, lw) { pdf.setDrawColor(c[0], c[1], c[2]); if (lw != null) pdf.setLineWidth(lw); }
  // Anchos reales de Helvetica y Helvetica-Bold (métricas AFM de Adobe, en
  // milésimas de em), para los caracteres de WinAnsi. jsPDF los guarda
  // redondeados (556 → 550, 667 → 660) y al "²" le da 530 en vez de 333: al
  // alinear a la derecha o escribir un párrafo por tramos se acumulaba el
  // error y quedaban palabras pegadas o huecos. jsPDF tampoco suma el
  // espaciado entre letras al medir.
  var HELV_W = {
    n: { a: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
         l: [278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],
         x: [556,222,556,333,1000,556,556,333,1000,667,333,1000,611,222,222,333,333,350,556,1000,333,1000,500,333,944,500,667] },
    b: { a: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
         l: [278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556],
         x: [556,278,556,500,1000,556,556,333,1000,667,333,1000,611,278,278,500,500,350,556,1000,333,1000,556,333,944,500,667] }
  };
  var HELV_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  function pMedir(pdf, t) {
    var f = pdf.getFont();
    if (f.fontName !== 'helvetica') return pdf.getTextWidth(t);
    var tab = f.fontStyle === 'bold' ? HELV_W.b : HELV_W.n, s = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i), k;
      if (c >= 32 && c < 127) s += tab.a[c - 32];
      else if (c >= 160 && c < 256) s += tab.l[c - 160];
      else s += (k = HELV_EXTRA.indexOf(t[i])) >= 0 ? tab.x[k] : 556;
    }
    return s / 1000 * pdf.getFontSize();
  }
  function pAncho(pdf, t, cs) { return pMedir(pdf, t) + (cs || 0) * Math.max(0, t.length - 1); }
  function pT(pdf, t, x, y, o) {
    o = o || {}; t = pdfTxt(t);
    var cs = o.cs || 0, al = o.align || 'left', x0 = x;
    if (al !== 'left') { var w = pAncho(pdf, t, cs); x0 = al === 'center' ? x - w / 2 : x - w; }
    if (cs) pdf.text(t, x0, y, { charSpace: cs }); else pdf.text(t, x0, y);
  }

  // Antes de pasar de hoja se anota hasta dónde llegó el contenido: al final se
  // usa para poner el skyline decorativo solo donde sobra lugar.
  function pHoja(doc) {
    var n = doc.pdf.getNumberOfPages();
    if (n >= 2) doc.fin[n] = doc.y;
    doc.pdf.addPage(); pCabecera(doc); doc.y = PDF_CAB + 28;
  }
  function pLimite(doc) { return doc.H - PDF_PIE - 20; }
  function pEspacio(doc, alto) { if (doc.y + alto > pLimite(doc)) pHoja(doc); }

  // ---------- Íconos de los títulos (dibujados en una caja de 10 x 10) ----------
  function pIcono(pdf, tipo, x, y, s) {
    var k = s / 10;
    pDraw(pdf, PDF.gold, 0.9); pdf.setLineCap('round'); pdf.setLineJoin('round');
    function L(pts) { for (var i = 1; i < pts.length; i++) pdf.line(x + pts[i-1][0]*k, y + pts[i-1][1]*k, x + pts[i][0]*k, y + pts[i][1]*k); }
    if (tipo === 'user') {
      pdf.circle(x + 5*k, y + 3.3*k, 2.1*k, 'S');
      pdf.lines([[0, -3.6*k, 6.6*k, -3.6*k, 6.6*k, 0]], x + 1.7*k, y + 9.6*k, [1,1], 'S', false);
    } else if (tipo === 'home') { L([[1,5],[5,1.4],[9,5]]); L([[2.2,4.2],[2.2,9.4],[7.8,9.4],[7.8,4.2]]); }
    else if (tipo === 'chart') { L([[0.8,9.4],[9.2,9.4]]); L([[2.6,9.4],[2.6,5.6]]); L([[5,9.4],[5,2.2]]); L([[7.4,9.4],[7.4,6.6]]); }
    else if (tipo === 'doc') { L([[2,0.8],[6.4,0.8],[8.6,3],[8.6,9.4],[2,9.4],[2,0.8]]); L([[6.4,0.8],[6.4,3],[8.6,3]]); L([[3.6,5.4],[7,5.4]]); L([[3.6,7.4],[7,7.4]]); }
    else { L([[8.4,1.2],[1.6,1.2],[5.2,5.2],[1.6,9.2],[8.4,9.2]]); }
    pdf.setLineCap('butt'); pdf.setLineJoin('miter');
  }
  // Título de sección. Sin coordenadas ocupa todo el ancho y avanza doc.y; con
  // coordenadas se usa para las dos columnas de la primera hoja.
  // Con un objeto { min } en lugar de coordenadas, se asegura ese lugar debajo
  // del título para que no quede solo al pie de una hoja.
  function pSeccion(doc, icono, titulo, x, ancho, y) {
    var pdf = doc.pdf, libre = (y == null);
    if (libre) {
      var o = (x && typeof x === 'object') ? x : {}, min = o.min || 50, antes = o.antes || 0, yPrev = doc.y;
      pEspacio(doc, 26 + min + antes);
      if (doc.y === yPrev) doc.y += antes;   // aire extra solo si sigue en la misma hoja
      x = doc.M; ancho = doc.W - 2 * doc.M; y = doc.y;
    }
    pIcono(pdf, icono, x, y - 7.8, 8.8);
    pF(pdf, 'bold', 8.8, PDF.navy); pT(pdf, titulo, x + 14, y, { cs: 0.35 });
    pDraw(pdf, PDF.gold, 1.3); pdf.line(x, y + 5.5, x + ancho, y + 5.5);
    if (libre) doc.y = y + 16;
    return y + 16;
  }

  // ---------- Texto con **negritas**, cortado al ancho ----------
  function pPartirRico(pdf, txt, tam, ancho) {
    var palabras = [];
    String(txt).split('**').forEach(function(seg, i){
      var b = i % 2 === 1;
      seg.split(/( +)/).forEach(function(w){
        if (w === '') return;
        if (/^ +$/.test(w)) palabras.push({ esp: true, b: b });
        else palabras.push({ t: pdfTxt(w), b: b });
      });
    });
    var lineas = [], linea = [], acum = 0;
    palabras.forEach(function(w){
      pdf.setFont('helvetica', w.b ? 'bold' : 'normal'); pdf.setFontSize(tam);
      if (w.esp) { if (linea.length) { var we = pMedir(pdf, ' '); linea.push({ t: ' ', b: w.b, w: we }); acum += we; } return; }
      var wd = pMedir(pdf, w.t);
      if (acum + wd > ancho && linea.length) {
        while (linea.length && linea[linea.length - 1].t === ' ') acum -= linea.pop().w;
        lineas.push(linea); linea = []; acum = 0;
      }
      linea.push({ t: w.t, b: w.b, w: wd }); acum += wd;
    });
    while (linea.length && linea[linea.length - 1].t === ' ') linea.pop();
    if (linea.length) lineas.push(linea);
    return lineas;
  }
  // Dibuja renglones ya cortados. y es el borde de arriba del primer renglón.
  // Cada renglón se escribe en tramos del mismo estilo (no palabra por palabra):
  // así el visor ubica las letras con sus medidas reales.
  function pDibujarLineas(pdf, lineas, x, y, tam, ih, color, colorB) {
    lineas.forEach(function(l, i){
      var cx = x, by = y + tam + i * ih, tramo = '', neg = null;
      function volcar() {
        if (!tramo) return;
        pdf.setFont('helvetica', neg ? 'bold' : 'normal'); pdf.setFontSize(tam);
        var c = neg ? colorB : color; pdf.setTextColor(c[0], c[1], c[2]);
        pdf.text(tramo, cx, by); cx += pMedir(pdf, tramo); tramo = '';
      }
      l.forEach(function(p){ if (neg !== null && p.b !== neg) volcar(); neg = p.b; tramo += p.t; });
      volcar();
    });
  }
  function pParrafo(doc, txt, o) {
    o = o || {};
    var pdf = doc.pdf, x = o.x != null ? o.x : doc.M, ancho = o.ancho || (doc.W - 2 * doc.M);
    var tam = o.tam || 8.5, ih = o.ih || tam * 1.55;
    var lineas = pPartirRico(pdf, txt, tam, ancho);
    pEspacio(doc, lineas.length * ih + 4);
    pDibujarLineas(pdf, lineas, x, doc.y, tam, ih, o.color || PDF.texto, o.colorB || PDF.navy);
    doc.y += lineas.length * ih + (o.despues != null ? o.despues : 10);
  }
  // Caja con fondo claro y filete dorado (o azul, con oscuro:true).
  function pCajaTexto(doc, parrafos, o) {
    o = o || {};
    var pdf = doc.pdf, M = doc.M, ancho = doc.W - 2 * M, tam = o.tam || 8.4, ih = tam * 1.58, pad = 14;
    var bloques = parrafos.map(function(t){ return pPartirRico(pdf, t, tam, ancho - 2 * pad - 4); });
    var cuerpo = bloques.reduce(function(s, b){ return s + b.length * ih; }, 0) + (bloques.length - 1) * 6;
    var alto = pad * 2 + cuerpo - (ih - tam) + 2;
    pEspacio(doc, alto + 16);
    var y = doc.y;
    if (o.oscuro) { pFill(pdf, PDF.navy); pdf.roundedRect(M, y, ancho, alto, 8, 8, 'F'); }
    else { pFill(pdf, PDF.claro); pdf.rect(M, y, ancho, alto, 'F'); pFill(pdf, PDF.gold); pdf.rect(M, y, 2.4, alto, 'F'); }
    var yy = y + pad;
    bloques.forEach(function(b){
      pDibujarLineas(pdf, b, M + pad + (o.oscuro ? 0 : 4), yy, tam, ih, o.color || PDF.texto, o.colorB || PDF.navy);
      yy += b.length * ih + 6;
    });
    doc.y = y + alto + 22;
  }

  // ---------- Tablas ----------
  // Filas "dato: valor". Los vacíos van con raya, como en el informe anterior.
  function pDatos(pdf, filas, x, y, ancho, anchoEtq) {
    filas.forEach(function(f, i){
      var vacio = f[1] === '' || f[1] == null;
      pF(pdf, 'normal', 8.2);
      var lineas = vacio ? ['—'] : pdf.splitTextToSize(pdfTxt(f[1]), ancho - anchoEtq - 2);
      var alto = Math.max(15.5, 5.5 + lineas.length * 10.2);
      pF(pdf, 'bold', 7.6, PDF.gris); pT(pdf, f[0] + ':', x, y + 10.6);
      pF(pdf, 'normal', 8.2, vacio ? [190,195,202] : PDF.tinta);
      lineas.forEach(function(l, j){ pdf.text(l, x + anchoEtq, y + 10.6 + j * 10.2); });
      if (i < filas.length - 1) { pDraw(pdf, [238,240,243], 0.6); pdf.line(x, y + alto, x + ancho, y + alto); }
      y += alto;
    });
    return y;
  }
  // ---------- Skyline decorativo (misma silueta que tenía el informe) ----------
  var SKYLINE = [
    ['r',20,60,40,60],['w',28,68,6,6],['w',44,68,6,6],
    ['r',72,40,34,80],['w',80,50,5,5],['w',92,50,5,5],['w',80,64,5,5],
    ['h',118,30,44,90,140,14],
    ['r',175,55,44,65],['w',185,64,6,6],['w',200,64,6,6],
    ['r',232,72,30,48],
    ['r',275,48,38,72],['w',284,58,5,5],['w',298,58,5,5],
    ['h',325,38,46,82,348,22],
    ['r',384,62,40,58],['w',394,70,6,6],['w',410,70,6,6],
    ['r',438,50,34,70],
    ['r',485,68,40,52],['w',495,76,6,6],
    ['h',540,34,44,86,562,18],
    ['r',598,58,42,62],['w',608,68,6,6],['w',624,68,6,6],
    ['r',654,44,36,76],['w',663,54,5,5],
    ['r',704,64,40,56],['w',714,72,6,6],
    ['r',756,56,20,64]
  ];
  function pSkyline(pdf, x, yBase, w, h, color, colorVentana) {
    var sx = w / 794, sy = h / 120, y0 = yBase - h;
    SKYLINE.forEach(function(s){
      if (s[0] === 'w') { pFill(pdf, colorVentana); pdf.rect(x + s[1] * sx, y0 + s[2] * sy, s[3] * sx, s[4] * sy, 'F'); return; }
      pFill(pdf, color);
      pdf.rect(x + s[1] * sx, y0 + s[2] * sy, s[3] * sx, s[4] * sy, 'F');
      if (s[0] === 'h') pdf.triangle(x + s[1] * sx, y0 + s[2] * sy, x + s[5] * sx, y0 + s[6] * sy, x + (s[1] + s[3]) * sx, y0 + s[2] * sy, 'F');
    });
  }



  // ---------- Encabezado y pie de las hojas del informe ----------
  // Recorta un texto al ancho dado, con puntos suspensivos.
  function pCortar(pdf, t, maxW) {
    t = pdfTxt(t);
    if (pMedir(pdf, t) <= maxW) return t;
    while (t.length > 1 && pMedir(pdf, t + '…') > maxW) t = t.slice(0, -1);
    return t.replace(/[\s.,;:-]+$/, '') + '…';
  }
  // Achica la letra hasta que el texto entre en el ancho (títulos largos como
  // "DERECHO DE HABITACIÓN").
  function pAjustar(pdf, t, tam, min, maxW, cs) {
    while (tam > min && pAncho(pdf, pdfTxt(t), cs || 0) > maxW) { tam -= 0.5; pdf.setFontSize(tam); }
    return tam;
  }

  // ---------- Encabezado y pie de las hojas ----------
  function pCabecera(doc) {
    var pdf = doc.pdf, W = doc.W, M = doc.M, d = doc.info;
    pFill(pdf, PDF.navy); pdf.rect(0, 0, W, PDF_CAB, 'F');
    pFill(pdf, PDF.gold); pdf.rect(0, PDF_CAB, W, 2, 'F');
    var colW = 62, isoH = 27, isoW = isoH * 120 / 105, txtH = 8.4, txtW = txtH * 300 / 41;
    try { pdf.addImage(LOGO_ISO, 'PNG', M + (colW - isoW) / 2, 12, isoW, isoH, 'tIso', 'FAST'); } catch (e) {}
    try { pdf.addImage(LOGO_TXT, 'PNG', M + (colW - txtW) / 2, 12 + isoH + 5, txtW, txtH, 'tTxt', 'FAST'); } catch (e) {}
    pDraw(pdf, [64, 78, 98], 0.7); pdf.line(M + colW + 13, 15, M + colW + 13, PDF_CAB - 15);
    var tx = M + colW + 26;
    pF(pdf, 'bold', 15, [255,255,255]); pT(pdf, 'INFORME DE PORTALES', tx, 33);
    pF(pdf, 'normal', 7.4, PDF.gold); pT(pdf, 'ESTADO Y ESTADÍSTICAS · ÚLTIMOS 30 DÍAS', tx, 46, { cs: 1.5 });
    var rx = W - M;
    pF(pdf, 'normal', 6.2, [138,147,160]); pT(pdf, 'FECHA', rx, 19.5, { align: 'right' });
    pF(pdf, 'normal', 7.8, [255,255,255]); pT(pdf, d.fecha, rx, 29, { align: 'right' });
    if (d.codigo) {
      pF(pdf, 'normal', 6.2, [138,147,160]); pT(pdf, 'CÓDIGO', rx, 41.5, { align: 'right' });
      pF(pdf, 'normal', 7.8, [255,255,255]); pT(pdf, pCortar(pdf, d.codigo, 110), rx, 51, { align: 'right' });
    }
  }
  function pPie(doc, n, total) {
    var pdf = doc.pdf, W = doc.W, H = doc.H, M = doc.M, y0 = H - PDF_PIE;
    pFill(pdf, PDF.navy); pdf.rect(0, y0, W, PDF_PIE, 'F');
    pF(pdf, 'bold', 7.5, PDF.gold); pT(pdf, 'MALAVE INMOBILIARIA', M, y0 + 15);
    pF(pdf, 'normal', 6.8, [205,210,216]); pT(pdf, 'Tel: +598 94 029 297  ·  Malaveinmobiliaria@gmail.com  ·  malaveinmobiliaria.com', M, y0 + 26);
    pF(pdf, 'normal', 6.3, [138,147,160]); pT(pdf, 'Montevideo, Uruguay', M, y0 + 36);
    pF(pdf, 'normal', 6.2, [150,156,164]);
    pT(pdf, 'Datos informados por cada portal', W - M, y0 + 15, { align: 'right' });
    pT(pdf, 'al ' + doc.info.fecha + '.', W - M, y0 + 23.5, { align: 'right' });
    if (total > 1) { pF(pdf, 'bold', 6.6, [205,210,216]); pT(pdf, 'Página ' + n + ' de ' + total, W - M, y0 + 35, { align: 'right' }); }
  }

  // ---------- Portada: mismo modelo que el tasador, el terreno y el usufructo ----------
  function pPortada(doc, d) {
    var pdf = doc.pdf, W = doc.W, H = doc.H;
    pFill(pdf, PDF.navy); pdf.rect(0, 0, W, 6, 'F');
    pFill(pdf, PDF.gold); pdf.rect(0, 6, W, 2.2, 'F');
    var isoH = 82, isoW = isoH * 120 / 105, txtH = 22.5, txtW = txtH * 300 / 41;
    var boxW = txtW + 80, boxH = 26 + isoH + 14 + txtH + 26, bx = (W - boxW) / 2, by = 92;
    pDraw(pdf, PDF.linea, 0.8); pdf.roundedRect(bx, by, boxW, boxH, 12, 12, 'S');
    try { pdf.addImage(LOGO_ISO_DARK, 'PNG', (W - isoW) / 2, by + 26, isoW, isoH, 'tIsoOsc', 'FAST'); } catch (e) {}
    try { pdf.addImage(LOGO_TXT_DARK, 'PNG', (W - txtW) / 2, by + 26 + isoH + 14, txtW, txtH, 'tTxtOsc', 'FAST'); } catch (e) {}
    var ty = by + boxH + 70;
    pF(pdf, 'normal', 11, PDF.gold); pT(pdf, 'INFORME DE', W / 2, ty - 34, { cs: 4.5, align: 'center' });
    pF(pdf, 'bold', 29, PDF.navy); pT(pdf, 'PORTALES', W / 2, ty, { cs: 2.3, align: 'center' });
    pF(pdf, 'normal', 10, PDF.gold);
    pAjustar(pdf, d.portalesTexto, 10, 7, W - 120, 3.2);
    pT(pdf, d.portalesTexto, W / 2, ty + 25, { cs: 3.2, align: 'center' });
    pFill(pdf, PDF.gold); pdf.rect(W / 2 - 34, ty + 44, 68, 2.2, 'F');
    pF(pdf, 'normal', 9.6, PDF.gris2);
    pT(pdf, 'Estado de la publicación y estadísticas de los últimos 30 días', W / 2, ty + 72, { align: 'center' });
    // Pie: el agente de la propiedad y la fecha
    var yPie = H - 64;
    pFill(pdf, PDF.navy); pdf.rect(0, yPie, W, 64, 'F');
    pFill(pdf, PDF.gold); pdf.rect(0, H - 2.4, W, 2.4, 'F');
    if (d.agente && d.agente.name) {
      pF(pdf, 'bold', 9.8, [255,255,255]); pT(pdf, pCortar(pdf, d.agente.name, 280), 72, yPie + 27);
      pF(pdf, 'normal', 7.4, [138,147,160]); pT(pdf, 'Asesor inmobiliario · MALAVE', 72, yPie + 39.5);
    } else {
      pF(pdf, 'bold', 9.8, [255,255,255]); pT(pdf, 'MALAVE INMOBILIARIA', 72, yPie + 27);
      pF(pdf, 'normal', 7.4, [138,147,160]); pT(pdf, 'Operador inmobiliario · Ley N.º 20.380', 72, yPie + 39.5);
    }
    pF(pdf, 'bold', 9.8, [255,255,255]); pT(pdf, d.fecha, W - 72, yPie + 27, { align: 'right' });
    pF(pdf, 'normal', 7.4, [138,147,160]); pT(pdf, 'Fecha de emisión', W - 72, yPie + 39.5, { align: 'right' });
    pSkyline(pdf, 34, yPie, W - 68, 62, [238,240,242], [248,248,250]);
    // Tarjeta con los datos de la propiedad
    var cardW = W - 144, cx = 72, pad = 24, anchoVal = 300;
    var filas = d.portadaFilas;
    pF(pdf, 'bold', 9.8);
    var bloques = filas.map(function(f){ return pdf.splitTextToSize(pdfTxt(f[1] || '-'), anchoVal).slice(0, 2); });
    var altos = bloques.map(function(b){ return Math.max(12, b.length * 12.5); });
    var sepF = filas.length > 4 ? 11 : 15, cardH = pad * 2 + altos.reduce(function(s, a){ return s + a; }, 0) + sepF * 2 * (filas.length - 1) - 2;
    var cy = yPie - 62 - 22 - cardH;
    pFill(pdf, PDF.claro); pDraw(pdf, PDF.linea, 0.8); pdf.roundedRect(cx, cy, cardW, cardH, 12, 12, 'FD');
    var yy = cy + pad;
    filas.forEach(function(f, i){
      pF(pdf, 'normal', 8.4, PDF.gris2); pT(pdf, f[0], cx + pad, yy + 9, { cs: 0.9 });
      pF(pdf, 'bold', 9.8, PDF.navy);
      bloques[i].forEach(function(l, j){ pT(pdf, l, cx + cardW - pad, yy + 9 + j * 12.5, { align: 'right' }); });
      yy += altos[i];
      if (i < filas.length - 1) { pDraw(pdf, PDF.linea, 0.7); pdf.line(cx + pad, yy + sepF - 2, cx + cardW - pad, yy + sepF - 2); yy += sepF * 2; }
    });
  }

  // ---------- Piezas de las hojas ----------
  var TONO = {
    ok: { bg: [234,247,240], fg: [21,122,82] }, warn: { bg: [255,246,232], fg: [138,90,0] },
    err: { bg: [253,236,237], fg: [192,57,43] }, off: { bg: [241,245,249], fg: [100,116,139] },
    idle: { bg: [238,242,247], fg: [22,39,63] }, busy: { bg: [253,246,227], fg: [122,97,26] }
  };
  // Pastilla con el estado (Activa, Pausada…). Devuelve el ancho que ocupó.
  function pPastilla(pdf, texto, tono, x, y) {
    var c = TONO[tono] || TONO.off;
    pF(pdf, 'bold', 7.8); var w = pAncho(pdf, pdfTxt(texto)) + 24;
    pFill(pdf, c.bg); pdf.roundedRect(x, y, w, 15, 7.5, 7.5, 'F');
    pFill(pdf, c.fg); pdf.circle(x + 9, y + 7.5, 2.2, 'F');
    pF(pdf, 'bold', 7.8, c.fg); pT(pdf, texto, x + 15, y + 10.4);
    return w;
  }
  // Tabla de varias columnas con encabezado. cols = [{ t, w, bold, align }]
  function pTabla(doc, cols, filas) {
    var pdf = doc.pdf, M = doc.M, ancho = doc.W - 2 * M, pad = 8;
    var tot = cols.reduce(function(s, c){ return s + c.w; }, 0);
    var xs = [], acc = M;
    cols.forEach(function(c){ xs.push(acc); acc += ancho * c.w / tot; });
    var anchoCol = function(i){ return ancho * cols[i].w / tot - 2 * pad; };
    var cuerpos = filas.map(function(f){
      return f.map(function(v, i){
        pF(pdf, cols[i].bold ? 'bold' : 'normal', 8.2);
        return pdf.splitTextToSize(pdfTxt(v == null || v === '' ? '—' : v), anchoCol(i)).slice(0, 3);
      });
    });
    var altos = cuerpos.map(function(c){ return 10 + Math.max.apply(null, c.map(function(l){ return l.length; })) * 10.4; });
    pEspacio(doc, 22 + altos.reduce(function(s, a){ return s + a; }, 0) + 8);
    var y = doc.y;
    pFill(pdf, PDF.fondo); pdf.rect(M, y, ancho, 18, 'F');
    cols.forEach(function(c, i){ pF(pdf, 'bold', 7, PDF.gris); pT(pdf, c.t.toUpperCase(), c.align === 'right' ? xs[i] + ancho * c.w / tot - pad : xs[i] + pad, y + 12, { cs: 0.6, align: c.align === 'right' ? 'right' : 'left' }); });
    y += 18;
    cuerpos.forEach(function(c, r){
      c.forEach(function(lineas, i){
        var col = cols[i];
        pF(pdf, col.bold ? 'bold' : 'normal', 8.2, col.bold ? PDF.navy : (filas[r][i] == null || filas[r][i] === '' ? [190,195,202] : PDF.tinta));
        lineas.forEach(function(l, j){ pT(pdf, l, col.align === 'right' ? xs[i] + ancho * col.w / tot - pad : xs[i] + pad, y + 13.5 + j * 10.4, { align: col.align === 'right' ? 'right' : 'left' }); });
      });
      y += altos[r];
      pDraw(pdf, [236,238,241], 0.6); pdf.line(M, y, M + ancho, y);
    });
    doc.y = y + 18;
  }
  // Recuadros con números (los de los últimos 30 días).
  function pNumeros(doc, items) {
    var pdf = doc.pdf, M = doc.M, W = doc.W, gap = 8, n = items.length;
    if (!n) return;
    var w = (W - 2 * M - gap * (n - 1)) / n, h = 52;
    pEspacio(doc, h + 14);
    var y = doc.y;
    items.forEach(function(it, i){
      var x = M + i * (w + gap);
      if (it.destacado) { pFill(pdf, PDF.navy); pdf.roundedRect(x, y, w, h, 8, 8, 'F'); }
      else { pFill(pdf, PDF.claro); pDraw(pdf, PDF.linea, 0.8); pdf.roundedRect(x, y, w, h, 8, 8, 'FD'); }
      pF(pdf, 'bold', 17, it.destacado ? [255,255,255] : PDF.navy); pAjustar(pdf, it.v, 17, 10, w - 16);
      pT(pdf, it.v, x + 12, y + 24);
      pF(pdf, 'normal', 7.4, it.destacado ? [205,210,216] : PDF.gris);
      var l = pdf.splitTextToSize(pdfTxt(it.t), w - 22).slice(0, 2);
      l.forEach(function(t, j){ pT(pdf, t, x + 12, y + 36 + j * 9); });
    });
    doc.y = y + h + 16;
  }
  // Gráfico de barras de los últimos 30 días (la misma serie que el modal).
  function pGrafico(doc, g) {
    var pdf = doc.pdf, M = doc.M, ancho = doc.W - 2 * M, H = 128;
    var serie = g.serie || [];
    pEspacio(doc, H + 40);
    var y = doc.y;
    var tot = serie.reduce(function(s, x){ return s + x.total; }, 0);
    pF(pdf, 'bold', 8.6, PDF.navy); pT(pdf, g.titulo, M, y + 8);
    if (serie.length >= 2) {
      pF(pdf, 'bold', 10, PDF.navy);
      var tTot = String(tot), tSub = ' ' + (tot === 1 ? g.singular : g.plural) + ' en ' + serie.length + ' días';
      pF(pdf, 'normal', 7.6); var wSub = pAncho(pdf, pdfTxt(tSub));
      pF(pdf, 'normal', 7.6, PDF.gris); pT(pdf, tSub, M + ancho, y + 8, { align: 'right' });
      pF(pdf, 'bold', 10, PDF.navy); pT(pdf, tTot, M + ancho - wSub, y + 8, { align: 'right' });
    }
    y += 16;
    if (serie.length < 2 || !tot) {
      pDraw(pdf, [207,213,221], 0.7); pdf.setLineDashPattern([3, 2], 0);
      pdf.roundedRect(M, y, ancho, 36, 6, 6, 'S'); pdf.setLineDashPattern([], 0);
      pF(pdf, 'normal', 8, PDF.gris); pT(pdf, serie.length < 2 ? 'El portal no informó datos por día.' : 'Sin ' + g.plural + ' en este período.', M + ancho / 2, y + 21, { align: 'center' });
      doc.y = y + 36 + 20; return;
    }
    var L = 24, T = 12, B = 16, alto = H - T - B;
    var max = Math.max.apply(null, serie.map(function(x){ return x.total; }));
    var tope = Math.max(2, Math.ceil(max / 2) * 2);
    var yv = function(v){ return y + T + alto * (1 - v / tope); };
    [0, tope / 2, tope].forEach(function(v){
      pDraw(pdf, v ? [230,233,238] : [184,192,203], 0.6); pdf.line(M + L, yv(v), M + ancho, yv(v));
      pF(pdf, 'normal', 6.8, PDF.gris); pT(pdf, String(v), M + L - 5, yv(v) + 2.4, { align: 'right' });
    });
    var paso = (ancho - L) / serie.length, gap = Math.min(2.4, paso * 0.25), bw = Math.max(1, paso - gap);
    var pico = -1;
    serie.forEach(function(x, i){ if (pico < 0 && x.total === max) pico = i; });
    pFill(pdf, g.color);
    serie.forEach(function(x, i){
      if (!x.total) return;
      var x0 = M + L + i * paso + gap / 2, y0 = yv(x.total), h = yv(0) - y0;
      pFill(pdf, g.color); pdf.rect(x0, y0, bw, h, 'F');
      if (i === pico) { pF(pdf, 'bold', 7.2, PDF.navy); pT(pdf, String(x.total), x0 + bw / 2, y0 - 3.5, { align: 'center' }); }
    });
    var fmt = function(s){ return s.slice(8, 10) + '/' + s.slice(5, 7); };
    [0, Math.floor(serie.length / 2), serie.length - 1].forEach(function(i, k){
      var cx = M + L + i * paso + paso / 2;
      pF(pdf, 'normal', 6.8, PDF.gris); pT(pdf, fmt(serie[i].date), cx, y + H - 3, { align: k === 0 ? 'left' : k === 2 ? 'right' : 'center' });
    });
    doc.y = y + H + 16;
  }
  // Subtítulo chico dentro de un portal ("Lo que ve el cliente", etc.).
  function pSub(doc, t, min) {
    pEspacio(doc, 18 + (min || 40));
    pF(doc.pdf, 'bold', 8, PDF.gris); pT(doc.pdf, t.toUpperCase(), doc.M, doc.y + 6, { cs: 0.8 });
    doc.y += 14;
  }
  // Lista con viñeta dorada.
  function pLista(doc, items, o) {
    o = o || {};
    var pdf = doc.pdf, M = doc.M, ancho = doc.W - 2 * M - 14;
    items.forEach(function(t){
      pF(pdf, 'normal', 8.4);
      var l = pdf.splitTextToSize(pdfTxt(t), ancho);
      pEspacio(doc, l.length * 11 + 4);
      pFill(pdf, o.color || PDF.gold); pdf.circle(M + 3, doc.y + 6.2, 1.6, 'F');
      pF(pdf, 'normal', 8.4, PDF.tinta);
      l.forEach(function(s, j){ pT(pdf, s, M + 12, doc.y + 9 + j * 11); });
      doc.y += l.length * 11 + 3;
    });
    doc.y += 8;
  }

  // ---------- Hoja de resumen: la propiedad y todos los portales juntos ----------
  function pResumen(doc, d) {
    var M = doc.M, ancho = doc.W - 2 * M;
    pSeccion(doc, 'home', 'DATOS DE LA PROPIEDAD', { min: 60 });
    doc.y = pDatos(doc.pdf, d.datos, M, doc.y - 1, ancho, 130) + 24;
    pSeccion(doc, 'chart', 'RESUMEN DE TODOS LOS PORTALES', { min: 120 });
    pTabla(doc, [
      { t: 'Portal', w: 1.25, bold: true }, { t: 'Estado', w: 1.1 }, { t: 'Destacado', w: 1.35 }, { t: 'Últimos 30 días', w: 2.3 }
    ], d.tabla);
    pSub(doc, 'Totales de los últimos 30 días', 60);
    pNumeros(doc, d.totales);
    if (d.comprobado) pParrafo(doc, d.comprobado, { tam: 7.8, color: PDF.gris, despues: 6 });
  }
  // ---------- Una hoja por portal, con todo lo que muestra el modal ----------
  function pPortal(doc, p) {
    var pdf = doc.pdf, M = doc.M, ancho = doc.W - 2 * M;
    pSeccion(doc, 'doc', p.nombre.toUpperCase(), { min: 80, antes: p.mismaHoja ? 8 : 0 });
    // El estado, con su explicación al lado
    pEspacio(doc, 30);
    var w = pPastilla(pdf, p.estado, p.tono, M, doc.y - 2);
    if (p.explica) { pF(pdf, 'normal', 8.6, PDF.texto); pT(pdf, pCortar(pdf, p.explica, ancho - w - 12), M + w + 10, doc.y + 8.6); }
    doc.y += 24;
    if (p.lead) pParrafo(doc, p.lead, { tam: 8.4, color: PDF.texto, despues: 10 });
    if (p.datos && p.datos.length) doc.y = pDatos(pdf, p.datos, M, doc.y, ancho, 140) + 18;
    if (p.cliente && p.cliente.length) {
      pSub(doc, 'Lo que ve el cliente', 60);
      pTabla(doc, [{ t: 'Dato', w: 1.1, bold: true }, { t: 'En el portal', w: 2 }, { t: 'Comparado con la ficha', w: 1.6 }], p.cliente);
    }
    if (p.calidad) {
      pSub(doc, 'Calidad del aviso', 50);
      pNumeros(doc, p.calidad.numeros);
      if (p.calidad.texto) pCajaTexto(doc, [p.calidad.texto]);
      if (p.calidad.faltan && p.calidad.faltan.length) {
        pSub(doc, p.calidad.faltanTitulo, 30);
        pLista(doc, p.calidad.faltan);
      }
    }
    if ((p.metricas && p.metricas.length) || p.grafico) {
      pSub(doc, p.tituloNumeros || 'Últimos 30 días', 70);
      if (p.metricas && p.metricas.length) pNumeros(doc, p.metricas);
      if (p.grafico) pGrafico(doc, p.grafico);
    }
    if (p.ultimas && p.ultimas.length) {
      pSub(doc, 'Últimas consultas', 30);
      pLista(doc, p.ultimas);
    }
    if (p.notas && p.notas.length) pCajaTexto(doc, p.notas);
  }
  // d: lo arma imprimirInformePortales (app.js) con lo que el modal ya consultó.
  function armar(d) {
    var doc = pdfNuevoDoc();
    doc.info = d;
    pPortada(doc, d);
    pHoja(doc); pResumen(doc, d);
    // Lo corto (Tu web) va en la hoja del resumen; cada portal, en su hoja.
    d.portales.filter(function(p){ return p.mismaHoja; }).forEach(function(p){ pPortal(doc, p); });
    // y al pie de esa hoja, las aclaraciones (el agente ya va en la portada y en los datos).
    pSeccion(doc, 'doc', 'ACLARACIONES', { min: 60, antes: 6 });
    pCajaTexto(doc, d.aclaraciones);
    d.portales.filter(function(p){ return !p.mismaHoja; }).forEach(function(p){ pHoja(doc); pPortal(doc, p); });
    var total = doc.pdf.getNumberOfPages(), base = doc.H - PDF_PIE, hS = 40;
    doc.fin[total] = doc.y;
    for (var i = 2; i <= total; i++) {
      doc.pdf.setPage(i);
      if (doc.fin[i] != null && doc.fin[i] + 10 < base - hS) pSkyline(doc.pdf, doc.M, base, doc.W - 2 * doc.M, hS, [241,242,244], [250,250,251]);
      pPie(doc, i - 1, total - 1);
    }
    doc.pdf.setProperties({ title: pdfTxt('Informe de portales - ' + (d.codigo || d.titulo)), subject: 'Estado y estadísticas de la propiedad en los portales', author: 'MALAVE Inmobiliaria', creator: 'MALAVE' });
    return doc.pdf;
  }
  window.armarInformePortalesPDF = armar;
  window.informePortalesTxt = pdfTxt;
})();
