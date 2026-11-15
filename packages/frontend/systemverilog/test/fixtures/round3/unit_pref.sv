package pk;
  function int f();
    return 1;
  endfunction
endpackage

import pk::*;

function int f();
  return 2;
endfunction

module unit_mod;
  int x;
  initial begin
    x = f();
  end
endmodule
