package pk;
  function int f();
    return 1;
  endfunction
endpackage

function int f();
  return 2;
endfunction

module unit_mod;
  import pk::*;
  int x;
  initial begin
    x = f();
  end
endmodule
