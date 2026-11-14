import "DPI-C" function void dpi_f(int x);
function void unit_fn();
endfunction
module m_unit;
  initial dpi_f(4);
  initial unit_fn();
  initial dupf();
  initial other_unit_fn();
endmodule
